import assert from 'node:assert/strict';
import { chmodSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Log } from '../src/lib/actions.ts';
import { collectChanges, parseDiffIndex, type Change } from '../src/changes.ts';
import { createRepo, type TestRepo } from './helpers/repo.ts';

const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

function logger() {
  const warnings: string[] = [];
  const log: Log = { debug() {}, info() {}, warning: (m) => warnings.push(m), error() {} };
  return { log, warnings };
}

const byPath = (changes: Change[]) => Object.fromEntries(changes.map((c) => [c.path, c.mode]));

describe('collectChanges', () => {
  let repo: TestRepo;
  beforeEach(() => {
    repo = createRepo();
    repo.write({ '.gitignore': '*.log\n' });
    repo.commit('init', { 'a.txt': 'a\n', 'b.txt': 'b\n', 'docs/guide.md': 'guide\n', 'run.sh': 'echo\n', 'staged.txt': 's\n' });
  });
  afterEach(() => repo.cleanup());

  it('finds modified, added, deleted, executable and symlinked files', async () => {
    repo.write({ 'a.txt': 'changed\n', 'new dir/ünï.txt': 'new\n', 'ignored.log': 'x' });
    rmSync(join(repo.dir, 'b.txt'));
    chmodSync(join(repo.dir, 'run.sh'), 0o755);
    symlinkSync('../etc/passwd', join(repo.dir, 'link'));
    const { log } = logger();
    const local = await collectChanges(repo.dir, [], log, env);
    assert.equal(local.head, repo.git('rev-parse', 'HEAD'));
    assert.deepEqual(byPath(local.changes), {
      'a.txt': '100644',
      'b.txt': null,
      link: '120000',
      'new dir/ünï.txt': '100644',
      'run.sh': '100755',
    });
    const link = local.changes.find((c) => c.path === 'link')!;
    assert.equal((await local.read(link.sha!)).toString(), '../etc/passwd');
    const added = local.changes.find((c) => c.path === 'a.txt')!;
    assert.equal(added.sha, repo.git('hash-object', 'a.txt'));
  });

  it('includes staged changes and leaves the index and working tree alone', async () => {
    repo.write({ 'staged.txt': 'staged\n' });
    repo.git('add', 'staged.txt');
    repo.write({ 'a.txt': 'unstaged\n', 'untracked.txt': 'u\n' });
    const status = repo.git('status', '--porcelain=v1', '-z');
    const index = readFileSync(join(repo.dir, '.git', 'index'));
    const local = await collectChanges(repo.dir, [], logger().log, env);
    assert.deepEqual(Object.keys(byPath(local.changes)).sort(), ['a.txt', 'staged.txt', 'untracked.txt']);
    assert.equal(repo.git('status', '--porcelain=v1', '-z'), status);
    assert.deepEqual(readFileSync(join(repo.dir, '.git', 'index')), index);
  });

  it('limits changes to pathspecs relative to the working directory and warns about unmatched ones', async () => {
    repo.write({ 'a.txt': 'x\n', 'docs/guide.md': 'y\n', 'docs/new.md': 'z\n' });
    const { log, warnings } = logger();
    const local = await collectChanges(join(repo.dir, 'docs'), ['*.md', 'missing/**', ':(exclude)new.md'], log, env);
    assert.deepEqual(byPath(local.changes), { 'docs/guide.md': '100644' });
    assert.deepEqual(warnings, ["commit-paths entry 'missing/**' matches no files"]);
  });

  it('returns nothing when no pathspec matches', async () => {
    repo.write({ 'a.txt': 'x\n' });
    const local = await collectChanges(repo.dir, ['nope.txt'], logger().log, env);
    assert.deepEqual(local.changes, []);
  });

  it('works without an index file', async () => {
    rmSync(join(repo.dir, '.git', 'index'));
    const local = await collectChanges(repo.dir, [], logger().log, env);
    assert.deepEqual(local.changes, []);
  });

  it('skips submodule changes with a warning', async () => {
    const sub = createRepo();
    try {
      sub.commit('one');
      repo.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.dir, 'sub');
      repo.commit('add submodule');
      repo.git('-C', 'sub', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'two');
      const { log, warnings } = logger();
      const local = await collectChanges(repo.dir, [], log, env);
      assert.deepEqual(local.changes, []);
      assert.deepEqual(warnings, ["Skipping submodule change at 'sub'"]);
    } finally {
      sub.cleanup();
    }
  });

  it('fails outside a repository with commits', async () => {
    const empty = createRepo();
    try {
      await assert.rejects(collectChanges(empty.dir, [], logger().log, env), /rev-parse/);
    } finally {
      empty.cleanup();
    }
  });
});

describe('parseDiffIndex', () => {
  it('rejects unexpected output', () => {
    assert.throws(() => parseDiffIndex('garbage\0path\0', logger().log), /unexpected git diff-index output/);
  });

  it('treats type changes as updates', () => {
    const sha = 'a'.repeat(40);
    const out = `:100644 120000 ${'0'.repeat(40)} ${sha} T\0x\0`;
    assert.deepEqual(parseDiffIndex(out, logger().log), [{ path: 'x', mode: '120000', sha }]);
  });
});
