// Dependency-free GitHub REST client built on fetch.
import type { Log } from './actions.ts';

export const API_VERSION = '2022-11-28';

type Query = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  query?: Query;
  /** JSON request body. */
  body?: unknown;
  /** Raw request body; must be re-readable for retries. */
  data?: Blob | Uint8Array | string;
  contentType?: string;
  accept?: string;
  /** Safe to resend after a server error. Defaults to true for all methods except POST. */
  idempotent?: boolean;
  /** Statuses returned to the caller instead of thrown. */
  allowStatus?: readonly number[];
}

export interface ApiResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

export interface GitHubOptions {
  token: string;
  userAgent: string;
  apiUrl?: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: Log;
  maxRetries?: number;
  timeoutMs?: number;
  maxRetryDelayMs?: number;
}

export class GitHubError extends Error {
  readonly status: number;
  readonly requestId: string | undefined;

  constructor(status: number, message: string, requestId?: string) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.requestId = requestId;
  }
}

/** Template tag that percent-encodes values, keeping `/` for ref names. */
export function path(strings: TemplateStringsArray, ...values: readonly (string | number)[]): string {
  let out = strings[0] ?? '';
  values.forEach((value, i) => {
    const text = String(value);
    if (text.split('/').some((seg) => seg === '.' || seg === '..')) throw new Error(`unsafe path segment '${text}'`);
    out += encodeURIComponent(text).replaceAll('%2F', '/') + (strings[i + 1] ?? '');
  });
  return out;
}

export function nextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match) return match[1];
  }
  return undefined;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const RETRYABLE = new Set([500, 502, 503, 504]);

export class GitHub {
  readonly apiUrl: string;
  readonly #token: string;
  readonly #userAgent: string;
  readonly #origins: ReadonlySet<string>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #log: Log | undefined;
  readonly #maxRetries: number;
  readonly #timeoutMs: number;
  readonly #maxRetryDelayMs: number;

  constructor(options: GitHubOptions) {
    const api = new URL(options.apiUrl || process.env['GITHUB_API_URL'] || 'https://api.github.com');
    if (api.protocol !== 'https:' && !(api.protocol === 'http:' && LOOPBACK.has(api.hostname))) {
      throw new Error(`refusing non-https API URL '${api.origin}'`);
    }
    this.apiUrl = api.href.replace(/\/+$/, '');
    const origins = new Set([api.origin]);
    if (api.origin === 'https://api.github.com') origins.add('https://uploads.github.com');
    this.#origins = origins;
    this.#token = options.token;
    this.#userAgent = options.userAgent;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#log = options.log;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#maxRetryDelayMs = options.maxRetryDelayMs ?? 60_000;
  }

  /** Resolves a path or absolute URL; the token is only ever sent to the API origins. */
  url(target: string, query: Query = {}): URL {
    const url = /^https?:\/\//.test(target) ? new URL(target) : new URL(this.apiUrl + target);
    if (!this.#origins.has(url.origin)) throw new Error(`refusing to send credentials to '${url.origin}'`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  }

  async request<T>(method: string, target: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    const url = this.url(target, options.query);
    const label = `${method} ${url.pathname}`;
    const headers: Record<string, string> = {
      accept: options.accept ?? 'application/vnd.github+json',
      authorization: `Bearer ${this.#token}`,
      'user-agent': this.#userAgent,
      'x-github-api-version': API_VERSION,
    };
    let body: RequestInit['body'];
    if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers['content-type'] = 'application/json';
    } else if (options.data !== undefined) {
      body = options.data;
      headers['content-type'] = options.contentType ?? 'application/octet-stream';
    }
    const idempotent = options.idempotent ?? method !== 'POST';

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.#fetch(url, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(this.#timeoutMs) });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (idempotent && attempt < this.#maxRetries) {
          await this.#retry(label, attempt, this.#backoff(attempt), reason);
          continue;
        }
        throw new GitHubError(0, `${label} failed: ${reason}`);
      }

      if (res.ok || options.allowStatus?.includes(res.status)) {
        return { status: res.status, data: (await parseBody(res)) as T, headers: res.headers };
      }

      const delay = this.#retryDelay(res, attempt, idempotent);
      if (delay !== undefined) {
        await res.body?.cancel();
        await this.#retry(label, attempt, delay, `HTTP ${res.status}`);
        continue;
      }
      throw await toError(res, label);
    }
  }

  async *paginate<T>(target: string, query: Query = {}, pick: (page: unknown) => readonly T[] = (page) => page as T[]): AsyncGenerator<T> {
    let next: string | undefined = this.url(target, { per_page: 100, ...query }).href;
    while (next) {
      const res: ApiResponse<unknown> = await this.request<unknown>('GET', next);
      yield* pick(res.data);
      next = nextLink(res.headers.get('link'));
    }
  }

  #retryDelay(res: Response, attempt: number, idempotent: boolean): number | undefined {
    if (attempt >= this.#maxRetries) return undefined;
    const retryAfter = Number(res.headers.get('retry-after'));
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const limited = res.status === 429 || (res.status === 403 && (retryAfter > 0 || remaining === '0'));
    if (limited) {
      // Rejected requests were not processed, so any method may be retried.
      let delay = this.#backoff(attempt);
      if (retryAfter > 0) delay = retryAfter * 1000;
      else if (remaining === '0' && reset > 0) delay = reset * 1000 - Date.now();
      delay = Math.max(delay, 1000);
      return delay <= this.#maxRetryDelayMs ? delay : undefined;
    }
    return idempotent && RETRYABLE.has(res.status) ? this.#backoff(attempt) : undefined;
  }

  #backoff(attempt: number): number {
    const base = Math.min(this.#maxRetryDelayMs, 1000 * 2 ** attempt);
    return Math.round(base * (0.5 + Math.random() / 2));
  }

  async #retry(label: string, attempt: number, delay: number, reason: string): Promise<void> {
    this.#log?.warning(`${label}: ${reason}; retry ${attempt + 1}/${this.#maxRetries} in ${Math.ceil(delay / 1000)}s`);
    await this.#sleep(delay);
  }
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  return (res.headers.get('content-type') ?? '').includes('json') ? JSON.parse(text) : text;
}

async function toError(res: Response, label: string): Promise<GitHubError> {
  const requestId = res.headers.get('x-github-request-id') ?? undefined;
  let detail = res.statusText;
  try {
    const body = (await parseBody(res)) as { message?: string; errors?: { message?: string; code?: string; field?: string }[] } | string | null;
    if (typeof body === 'string' && body) detail = body.slice(0, 500);
    else if (body && typeof body === 'object') {
      const extra = (body.errors ?? []).map((e) => e.message ?? [e.field, e.code].filter(Boolean).join(' ')).filter(Boolean);
      detail = [body.message, ...extra].filter(Boolean).join('; ') || detail;
    }
  } catch {
    // Keep the status text.
  }
  const suffix = requestId ? ` (request ${requestId})` : '';
  return new GitHubError(res.status, `${label} failed with ${res.status}: ${detail}${suffix}`, requestId);
}
