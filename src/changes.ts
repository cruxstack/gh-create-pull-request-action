// Finds working-tree changes vs HEAD using a throwaway index; the real index and files are untouched.
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Log } from './lib/actions.ts';
import { Git, splitNul } from './lib/git.ts';

export type FileMode = '100644' | '100755' | '120000';

export interface Change {
  path: string;
  /** New mode and local blob SHA; both null for deletions. */
  mode: FileMode | null;
  sha: string | null;
}

export interface LocalState {
  /** Commit the changes are relative to. */
  head: string;
  changes: Change[];
  /** Reads a blob from the local object database (symlinks are never followed). */
  read(sha: string): Promise<Buffer>;
}

const RAW = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/;
const GITLINK = '160000';

export function parseDiffIndex(output: Buffer | string, log: Log): Change[] {
  const parts = splitNul(output);
  const changes: Change[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = RAW.exec(parts[i]!);
    const path = parts[i + 1]!;
    if (!m) throw new Error(`unexpected git diff-index output '${parts[i]}'`);
    const [, srcMode, dstMode, , dstSha, status] = m;
    if (srcMode === GITLINK || dstMode === GITLINK) {
      log.warning(`Skipping submodule change at '${path}'`);
      continue;
    }
    if (status === 'D') changes.push({ path, mode: null, sha: null });
    else changes.push({ path, mode: dstMode === '100755' || dstMode === '120000' ? dstMode : '100644', sha: dstSha! });
  }
  return changes;
}

/** Drops pathspecs that match no tracked or untracked (non-ignored) file. */
async function matchingPathspecs(git: Git, pathspecs: readonly string[], log: Log): Promise<string[]> {
  const matched: string[] = [];
  for (const spec of pathspecs) {
    const res = await git.run(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--error-unmatch', '--', spec], [0, 1]);
    if (res.code === 0) matched.push(spec);
    else log.warning(`commit-paths entry '${spec}' matches no files`);
  }
  return matched;
}

export async function collectChanges(cwd: string, pathspecs: readonly string[], log: Log, env: NodeJS.ProcessEnv = process.env): Promise<LocalState> {
  const git = new Git(cwd, env);
  const head = await git.text(['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']);
  const read = async (sha: string): Promise<Buffer> => (await git.run(['cat-file', 'blob', sha])).stdout;

  const tmp = mkdtempSync(join(env['RUNNER_TEMP'] || tmpdir(), 'pr-index-'));
  try {
    const index = join(tmp, 'index');
    const scratch = new Git(cwd, { ...env, GIT_INDEX_FILE: index });
    // Copying the real index keeps stat data (fast) and sparse-checkout bits (no false deletions).
    const realIndex = resolve(cwd, await git.text(['rev-parse', '--git-path', 'index']));
    if (existsSync(realIndex)) copyFileSync(realIndex, index);
    else await scratch.run(['read-tree', 'HEAD']);

    const specs = pathspecs.length ? await matchingPathspecs(scratch, pathspecs, log) : [':/'];
    if (!specs.length) return { head, changes: [], read };
    await scratch.run(['add', '-A', '--', ...specs]);
    const diff = await scratch.run(['diff-index', '--cached', '-z', '--no-renames', 'HEAD', '--', ...specs]);
    return { head, changes: parseDiffIndex(diff.stdout, log), read };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
