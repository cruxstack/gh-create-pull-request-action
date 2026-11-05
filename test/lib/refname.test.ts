import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertRefName, isCommitSha, parseRepository, refNameProblem } from '../../src/lib/refname.ts';

describe('refNameProblem', () => {
  it('accepts valid names', () => {
    for (const name of ['main', 'v1.2.3', 'feature/x-y_z', 'v1.0.0+build.1', 'release/2026.11']) assert.equal(refNameProblem(name), undefined, name);
  });

  it('rejects invalid names', () => {
    const bad = ['', '@', '/a', 'a/', 'a//b', 'a.', 'a..b', 'a@{b', 'a b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', '.a', 'a/.b', 'a.lock', 'a/b.lock/c', '-a', 'a\x7f', 'x'.repeat(256)];
    for (const name of bad) assert.notEqual(refNameProblem(name), undefined, JSON.stringify(name));
  });

  it('throws with context', () => {
    assert.equal(assertRefName('tag', 'v1'), 'v1');
    assert.throws(() => assertRefName('branch', 'a..b'), /branch 'a..b' contains '..'/);
  });
});

describe('isCommitSha', () => {
  it('accepts full SHA-1 and SHA-256 only', () => {
    assert.ok(isCommitSha('a'.repeat(40)));
    assert.ok(isCommitSha('b'.repeat(64)));
    assert.ok(!isCommitSha('A'.repeat(40)));
    assert.ok(!isCommitSha('abc1234'));
  });
});

describe('parseRepository', () => {
  it('splits owner and name', () => {
    assert.deepEqual(parseRepository('cruxstack/my.repo_x-1'), { owner: 'cruxstack', repo: 'my.repo_x-1' });
  });

  it('rejects malformed values', () => {
    for (const value of ['', 'a', 'a/b/c', '-a/b', 'a/..', 'a/b c']) assert.throws(() => parseRepository(value), /owner\/name/, value);
  });
});
