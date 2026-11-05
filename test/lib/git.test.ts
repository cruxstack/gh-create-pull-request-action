import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Git, GitError, splitNul } from '../../src/lib/git.ts';
import { createRepo, type TestRepo } from '../helpers/repo.ts';

describe('Git', () => {
  let repo: TestRepo;
  beforeEach(() => (repo = createRepo()));
  afterEach(() => repo.cleanup());

  it('runs commands and returns trimmed text', async () => {
    const sha = repo.commit('init', { 'a.txt': 'a' });
    const git = new Git(repo.dir);
    assert.equal(await git.text(['rev-parse', 'HEAD']), sha);
  });

  it('reports failures with stderr', async () => {
    const git = new Git(repo.dir);
    await assert.rejects(git.run(['rev-parse', 'nope']), (e) => e instanceof GitError && e.code === 128 && /nope/.test(e.message));
  });

  it('accepts extra exit codes', async () => {
    repo.commit('init', { 'a.txt': 'a' });
    repo.write({ 'a.txt': 'b' });
    const result = await new Git(repo.dir).run(['diff', '--quiet'], [0, 1]);
    assert.equal(result.code, 1);
  });

  it('checks for commits', async () => {
    const sha = repo.commit('init');
    const git = new Git(repo.dir);
    assert.equal(await git.has(sha), true);
    assert.equal(await git.has('f'.repeat(40)), false);
  });

  it('disables quoting of unusual paths', async () => {
    repo.commit('init', { 'ünï cödé.txt': 'x' });
    const out = await new Git(repo.dir).run(['ls-files', '-z']);
    assert.deepEqual(splitNul(out.stdout), ['ünï cödé.txt']);
  });
});

describe('splitNul', () => {
  it('drops the trailing terminator only', () => {
    assert.deepEqual(splitNul('a\0\0b\0'), ['a', '', 'b']);
    assert.deepEqual(splitNul(''), []);
  });
});
