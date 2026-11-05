import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';
import { Inputs } from '../src/lib/actions.ts';
import { BODY_MAX, readConfig } from '../src/config.ts';

const base = {
  'INPUT_GITHUB-TOKEN': 'tok',
  'INPUT_GITHUB-REPOSITORY': 'o/r',
  'INPUT_PR-HEAD-BRANCH': 'bot/update',
  'INPUT_PR-TITLE': 'Update things',
};
const read = (env: Record<string, string> = {}, cwd = '/work') => readConfig(new Inputs({ ...base, ...env }), cwd);

describe('readConfig', () => {
  it('applies defaults', () => {
    assert.deepEqual(read(), {
      token: 'tok',
      owner: 'o',
      repo: 'r',
      workingDirectory: '/work',
      commitMessage: 'chore: automated update',
      commitPaths: [],
      commitAuthor: undefined,
      headBranch: 'bot/update',
      baseBranch: '',
      title: 'Update things',
      body: undefined,
      labels: [],
      assignees: [],
      reviewers: [],
      teamReviewers: [],
      draft: false,
      closeIfEmpty: true,
    });
  });

  it('reads every option', () => {
    const config = read({
      'INPUT_WORKING-DIRECTORY': 'sub',
      'INPUT_COMMIT-MESSAGE': 'fix: regenerate',
      'INPUT_COMMIT-PATHS': 'docs/**\n:(exclude)docs/x.md',
      'INPUT_COMMIT-AUTHOR': 'Robo Bot <robo@example.com>',
      'INPUT_PR-BASE-BRANCH': 'release/1.x',
      'INPUT_PR-BODY': 'Body',
      'INPUT_PR-LABELS': 'deps, automated\ndeps',
      'INPUT_PR-ASSIGNEES': '@alice,bob',
      'INPUT_PR-REVIEWERS': 'carol\nrenovate[bot]',
      'INPUT_PR-TEAM-REVIEWERS': 'cruxstack/platform, sre',
      'INPUT_PR-DRAFT': 'true',
      'INPUT_PR-CLOSE-IF-EMPTY': 'false',
    });
    assert.equal(config.workingDirectory, '/work/sub');
    assert.equal(config.commitMessage, 'fix: regenerate');
    assert.deepEqual(config.commitPaths, ['docs/**', ':(exclude)docs/x.md']);
    assert.deepEqual(config.commitAuthor, { name: 'Robo Bot', email: 'robo@example.com' });
    assert.equal(config.baseBranch, 'release/1.x');
    assert.equal(config.body, 'Body');
    assert.deepEqual(config.labels, ['deps', 'automated']);
    assert.deepEqual(config.assignees, ['alice', 'bob']);
    assert.deepEqual(config.reviewers, ['carol', 'renovate[bot]']);
    assert.deepEqual(config.teamReviewers, ['platform', 'sre']);
    assert.equal(config.draft, true);
    assert.equal(config.closeIfEmpty, false);
  });

  it('reads the body from a file relative to the workspace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    try {
      writeFileSync(join(dir, 'body.md'), '# Report\n');
      assert.equal(read({ 'INPUT_PR-BODY-FILE': 'body.md' }, dir).body, '# Report\n');
      writeFileSync(join(dir, 'big.md'), 'x'.repeat(BODY_MAX + 1));
      assert.throws(() => read({ 'INPUT_PR-BODY-FILE': 'big.md' }, dir), /exceeds 65536/);
      writeFileSync(join(dir, 'huge.md'), 'x'.repeat(BODY_MAX * 4 + 1));
      assert.throws(() => read({ 'INPUT_PR-BODY-FILE': 'huge.md' }, dir), /exceeds 65536/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('confines the body file to the workspace', () => {
    const outside = mkdtempSync(join(tmpdir(), 'cfg-out-'));
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'nope');
      symlinkSync(join(outside, 'secret.txt'), join(dir, 'link.md'));
      mkdirSync(join(dir, 'folder'));
      assert.throws(() => read({ 'INPUT_PR-BODY-FILE': join(outside, 'secret.txt') }, dir), /outside the workspace/);
      assert.throws(() => read({ 'INPUT_PR-BODY-FILE': '../' + basename(outside) + '/secret.txt' }, dir), /outside the workspace/);
      assert.throws(() => read({ 'INPUT_PR-BODY-FILE': 'link.md' }, dir), /outside the workspace/);
      assert.throws(() => read({ 'INPUT_PR-BODY-FILE': 'folder' }, dir), /not a regular file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects invalid input', () => {
    assert.throws(() => read({ 'INPUT_PR-BODY': 'a', 'INPUT_PR-BODY-FILE': 'b' }), /only one of/);
    assert.throws(() => read({ 'INPUT_PR-HEAD-BRANCH': 'bad..name' }), /pr-head-branch 'bad..name'/);
    assert.throws(() => read({ 'INPUT_PR-BASE-BRANCH': 'x y' }), /pr-base-branch/);
    assert.throws(() => read({ 'INPUT_PR-TITLE': '' }), /pr-title' is required/);
    assert.throws(() => read({ 'INPUT_COMMIT-AUTHOR': 'nobody' }), /Name <email>/);
    assert.throws(() => read({ 'INPUT_PR-REVIEWERS': 'a b' }), /pr-reviewers entry 'a b'/);
    assert.throws(() => read({ 'INPUT_PR-DRAFT': 'maybe' }), /must be 'true' or 'false'/);
  });
});
