import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runAction } from './helpers/action.ts';
import type { Route } from './helpers/fake-fetch.ts';
import { createRepo, type TestRepo } from './helpers/repo.ts';

const BASE = 'b'.repeat(40);
const BASE_TREE = 'c'.repeat(40);
const NEW_TREE = 'd'.repeat(40);
const COMMIT = 'e'.repeat(40);
const env = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const inputs = {
  'github-token': 'e2e-token',
  'github-repository': 'o/r',
  'working-directory': '.',
  'commit-message': 'chore: regenerate',
  'pr-head-branch': 'bot/regen',
  'pr-title': 'Regenerate files',
  'pr-labels': 'automated',
  'pr-draft': 'false',
  'pr-close-if-empty': 'true',
};

const common = (head: string): Route[] => [
  { method: 'GET', path: '/repos/o/r', json: { default_branch: 'main' }, check: (req) => assert.equal(req.headers.get('authorization'), 'Bearer e2e-token') },
  { method: 'GET', path: '/repos/o/r/git/ref/heads/main', json: { object: { sha: BASE } } },
  { method: 'GET', path: `/repos/o/r/git/commits/${BASE}`, json: { tree: { sha: BASE_TREE } } },
  { method: 'GET', path: '/repos/o/r/git/ref/heads/bot/regen', status: 404, json: { message: 'Not Found' } },
  { method: 'GET', path: '/repos/o/r/pulls', json: [] },
  ...(head ? [{ method: 'GET', path: `/repos/o/r/git/commits/${head}`, json: {} }] : []),
];

describe('dist/main.js', () => {
  let repo: TestRepo;
  beforeEach(() => {
    repo = createRepo();
    repo.commit('init', { '.gitignore': '*.log\n', 'a.txt': 'old\n', 'c.txt': 'remove me\n' });
  });
  afterEach(() => repo.cleanup());

  it('commits working-tree changes through the API and opens a pull request', async () => {
    repo.write({ 'a.txt': 'new\n', 'bin.dat': Buffer.from([0, 255, 1]), 'debug.log': 'ignored' });
    rmSync(join(repo.dir, 'c.txt'));
    const head = repo.git('rev-parse', 'HEAD');
    const binSha = repo.git('hash-object', 'bin.dat');
    const status = repo.git('status', '--porcelain');

    const result = await runAction(
      inputs,
      [
        ...common(head),
        { method: 'GET', path: `/repos/o/r/git/trees/${BASE_TREE}`, json: { truncated: false, tree: [{ path: 'c.txt', type: 'blob', sha: '1'.repeat(40) }] } },
        { method: 'POST', path: '/repos/o/r/git/blobs', status: 201, json: { sha: binSha }, check: (req) => assert.deepEqual(req.json, { content: 'AP8B', encoding: 'base64' }) },
        {
          method: 'POST',
          path: '/repos/o/r/git/trees',
          status: 201,
          json: { sha: NEW_TREE },
          check: (req) =>
            assert.deepEqual(req.json, {
              base_tree: BASE_TREE,
              tree: [
                { path: 'a.txt', mode: '100644', type: 'blob', content: 'new\n' },
                { path: 'bin.dat', mode: '100644', type: 'blob', sha: binSha },
                { path: 'c.txt', mode: '100644', type: 'blob', sha: null },
              ],
            }),
        },
        { method: 'POST', path: '/repos/o/r/git/commits', status: 201, json: { sha: COMMIT }, check: (req) => assert.deepEqual(req.json, { message: 'chore: regenerate', tree: NEW_TREE, parents: [BASE] }) },
        { method: 'POST', path: '/repos/o/r/git/refs', status: 201, json: {}, check: (req) => assert.deepEqual(req.json, { ref: 'refs/heads/bot/regen', sha: COMMIT }) },
        { method: 'POST', path: '/repos/o/r/pulls', status: 201, json: { number: 3, html_url: 'https://github.com/o/r/pull/3' } },
        { method: 'POST', path: '/repos/o/r/issues/3/labels', json: [], check: (req) => assert.deepEqual(req.json, { labels: ['automated'] }) },
      ],
      { cwd: repo.dir, env },
    );
    assert.equal(result.stderr, '');
    assert.equal(result.code, 0, result.stdout);
    result.api.done();
    assert.match(result.stdout, /^::add-mask::e2e-token$/m);
    assert.deepEqual(result.outputs, {
      'pr-number': '3',
      'pr-url': 'https://github.com/o/r/pull/3',
      'pr-operation': 'created',
      'pr-head-sha': COMMIT,
      'pr-head-branch': 'bot/regen',
    });
    assert.equal(repo.git('status', '--porcelain'), status, 'working tree and index are untouched');
    assert.equal(repo.git('remote'), '', 'no remotes are added');
  });

  it('skips cleanly when nothing changed', async () => {
    const result = await runAction(inputs, common(''), { cwd: repo.dir, env });
    assert.equal(result.code, 0, result.stdout);
    result.api.done();
    assert.equal(result.outputs['pr-operation'], 'skipped');
  });

  it('fails the step on invalid input without calling the API', async () => {
    const result = await runAction({ ...inputs, 'pr-head-branch': 'main..x' }, [], { cwd: repo.dir, env });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /^::error::pr-head-branch 'main\.\.x' contains '\.\.'$/m);
    result.api.done();
  });
});
