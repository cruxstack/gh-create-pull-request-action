// Minimal GitHub Actions runtime: inputs, outputs, masking and logging.
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export type Env = Readonly<Record<string, string | undefined>>;
export type OutputValue = string | number | boolean;

export interface Log {
  debug(message: string): void;
  info(message: string): void;
  warning(message: string): void;
  error(message: string): void;
}

export class InputError extends Error {
  readonly input: string;

  constructor(input: string, problem: string) {
    super(`input '${input}' ${problem}`);
    this.name = 'InputError';
    this.input = input;
  }
}

export class Inputs {
  readonly #env: Env;

  constructor(env: Env) {
    this.#env = env;
  }

  /** Trimmed raw value; empty when unset. */
  get(name: string): string {
    return (this.#env[`INPUT_${name.replaceAll(' ', '_').toUpperCase()}`] ?? '').trim();
  }

  string(name: string, fallback = ''): string {
    return this.get(name) || fallback;
  }

  required(name: string): string {
    const value = this.get(name);
    if (!value) throw new InputError(name, 'is required');
    return value;
  }

  boolean(name: string, fallback: boolean): boolean {
    const value = this.get(name);
    if (value === '') return fallback;
    const lower = value.toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
    throw new InputError(name, `must be 'true' or 'false', got '${value}'`);
  }

  choice<const T extends string>(name: string, choices: readonly T[], fallback: T): T {
    const value = this.get(name);
    if (value === '') return fallback;
    const match = choices.find((c) => c === value);
    if (match === undefined) throw new InputError(name, `must be one of ${choices.join(', ')}; got '${value}'`);
    return match;
  }

  /** One value per line (and per comma when `commas`); blanks dropped. */
  list(name: string, { commas = false } = {}): string[] {
    const value = this.get(name);
    if (!value) return [];
    return value
      .split(commas ? /[\r\n,]+/ : /\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
}

const escapeData = (s: string): string => s.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');

export class Runtime {
  readonly env: Env;
  readonly inputs: Inputs;
  readonly log: Log;
  readonly #write: (line: string) => void;

  constructor(env: Env = process.env, write: (line: string) => void = (line) => void process.stdout.write(`${line}\n`)) {
    this.env = env;
    this.inputs = new Inputs(env);
    this.#write = write;
    const debugEnabled = env['RUNNER_DEBUG'] === '1';
    this.log = {
      debug: (m) => debugEnabled && write(`::debug::${escapeData(m)}`),
      info: (m) => write(m),
      warning: (m) => write(`::warning::${escapeData(m)}`),
      error: (m) => write(`::error::${escapeData(m)}`),
    };
  }

  mask(secret: string): void {
    for (const line of secret.split(/\r?\n/)) {
      if (line.trim()) this.#write(`::add-mask::${escapeData(line)}`);
    }
  }

  setOutputs(outputs: Readonly<Record<string, OutputValue>>): void {
    const file = this.env['GITHUB_OUTPUT'];
    if (!file) throw new Error('GITHUB_OUTPUT is not set');
    appendFileSync(file, formatOutputs(outputs), { encoding: 'utf8' });
  }
}

/** Heredoc format with a random delimiter so values cannot inject extra outputs. */
export function formatOutputs(outputs: Readonly<Record<string, OutputValue>>, delimiter = `ghadelimiter_${randomUUID()}`): string {
  let text = '';
  for (const [name, raw] of Object.entries(outputs)) {
    const value = String(raw);
    if (name.includes(delimiter) || value.includes(delimiter)) throw new Error(`output '${name}' contains the delimiter`);
    text += `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
  }
  return text;
}

/** Runs an action entrypoint, writes its outputs, and fails the step on error. */
export async function runAction(main: (rt: Runtime) => Promise<Record<string, OutputValue>>, rt = new Runtime()): Promise<void> {
  try {
    rt.setOutputs(await main(rt));
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    rt.log.error(err.message);
    if (err.stack) rt.log.debug(err.stack);
    process.exitCode = 1;
  }
}
