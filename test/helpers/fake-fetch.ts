// Scripted fetch: every request must match a route, and every route must be used.
import assert from 'node:assert/strict';

export interface Received {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
  json?: unknown;
}

export interface Route {
  method: string;
  /** Exact pathname or pattern; the query string is not matched. */
  path: string | RegExp;
  status?: number;
  json?: unknown;
  body?: string;
  headers?: Record<string, string>;
  check?: (req: Received) => void;
  /** Number of times the route must match. Defaults to 1. */
  times?: number;
}

export interface FakeFetch {
  fetch: typeof globalThis.fetch;
  calls: Received[];
  done(): void;
}

async function readBody(body: RequestInit['body']): Promise<string> {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  if (body instanceof Blob) return body.text();
  if (body instanceof Uint8Array) return Buffer.from(body).toString();
  return new Response(body).text();
}

export function fakeFetch(routes: readonly Route[]): FakeFetch {
  const pending = routes.map((route) => ({ route, left: route.times ?? 1 }));
  const calls: Received[] = [];
  const problems: string[] = [];

  const reply = (status: number, message: string): Response =>
    new Response(JSON.stringify({ message }), { status, headers: { 'content-type': 'application/json' } });

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    const body = await readBody(init?.body);
    const json = body && new Headers(init?.headers).get('content-type') === 'application/json' ? JSON.parse(body) : undefined;
    const req: Received = { method, url, headers: new Headers(init?.headers), body, ...(json === undefined ? {} : { json }) };
    calls.push(req);

    const match = pending.find(
      ({ route, left }) =>
        left > 0 && route.method === method && (typeof route.path === 'string' ? route.path === url.pathname : route.path.test(url.pathname)),
    );
    if (!match) {
      problems.push(`unexpected ${method} ${url.pathname}${url.search}`);
      return reply(418, 'unexpected request');
    }
    match.left--;
    try {
      match.route.check?.(req);
    } catch (error) {
      problems.push(`${method} ${url.pathname}: ${error instanceof Error ? error.message : String(error)}`);
      return reply(418, 'request check failed');
    }
    const headers = new Headers(match.route.headers);
    let payload: string | null = match.route.body ?? null;
    if (match.route.json !== undefined) {
      payload = JSON.stringify(match.route.json);
      headers.set('content-type', 'application/json');
    }
    return new Response(payload, { status: match.route.status ?? 200, headers });
  };

  return {
    fetch,
    calls,
    done() {
      assert.deepEqual(problems, [], 'request problems');
      const unused = pending.filter((p) => p.left > 0).map((p) => `${p.route.method} ${p.route.path}`);
      assert.deepEqual(unused, [], 'routes not called');
    },
  };
}
