// Throwaway local git repositories for tests.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface TestRepo {
  dir: string;
  git(...args: string[]): string;
  write(files: Record<string, string | Buffer>): void;
  commit(message: string, files?: Record<string, string | Buffer>): string;
  cleanup(): void;
}

export function createRepo(): TestRepo {
  const dir = mkdtempSync(join(tmpdir(), 'repo-'));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();
  const write = (files: Record<string, string | Buffer>): void => {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), content);
    }
  };
  git('init', '-q', '-b', 'main');
  return {
    dir,
    git,
    write,
    commit(message, files = {}) {
      write(files);
      git('add', '-A');
      git('commit', '-q', '--allow-empty', '-m', message);
      return git('rev-parse', 'HEAD');
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
