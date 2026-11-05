// Runs the built action in a child process against a local fake API server.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeFetch, type FakeFetch, type Route } from './fake-fetch.ts';

export const MAIN = fileURLToPath(new URL('../../dist/main.js', import.meta.url));

export interface ActionRun {
  code: number | null;
  stdout: string;
  stderr: string;
  outputs: Record<string, string>;
  api: FakeFetch;
}

export function parseOutputs(text: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  const pattern = /^([^<\n]+)<<(\S+)\n([\s\S]*?)\n\2\n/gm;
  for (const m of text.matchAll(pattern)) outputs[m[1]!] = m[3]!;
  return outputs;
}

async function readRequest(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export async function runAction(
  inputs: Record<string, string>,
  routes: readonly Route[],
  options: { env?: Record<string, string>; cwd?: string } = {},
): Promise<ActionRun> {
  const api = fakeFetch(routes);
  const server = createServer(async (req, res) => {
    const body = await readRequest(req);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value);
    const reply = await api.fetch(new URL(req.url ?? '/', 'http://127.0.0.1'), {
      method: req.method ?? 'GET',
      headers,
      ...(body.length ? { body: new Uint8Array(body) } : {}),
    });
    res.writeHead(reply.status, Object.fromEntries(reply.headers));
    res.end(Buffer.from(await reply.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const dir = mkdtempSync(join(tmpdir(), 'action-'));
  const outputFile = join(dir, 'output');
  writeFileSync(outputFile, '');
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    GITHUB_API_URL: `http://127.0.0.1:${port}`,
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_OUTPUT: outputFile,
    ...options.env,
  };
  for (const [name, value] of Object.entries(inputs)) env[`INPUT_${name.toUpperCase()}`] = value;

  try {
    const child = spawn(process.execPath, [MAIN], { env, cwd: options.cwd ?? dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    return { code, stdout, stderr, outputs: parseOutputs(readFileSync(outputFile, 'utf8')), api };
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
