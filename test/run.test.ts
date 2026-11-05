import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Log } from '../src/lib/actions.ts';
import { GitHub } from '../src/lib/github.ts';
import type { LocalState } from '../src/changes.ts';
import type { Config } from '../src/config.ts';
import { run } from '../src/run.ts';
import { fakeFetch, type Route } from './helpers/fake-fetch.ts';
import { fakeLocal } from './helpers/local.ts';

const LOCAL_HEAD = 'f'.repeat(40);
const BASE = 'b'.repeat(40);
const BASE_TREE = 'c'.repeat(40);
const NEW_TREE = 'd'.repeat(40);
const BRANCH = 'e'.repeat(40);
const COMMIT = '9'.repeat(40);

const config = (overrides: Partial<Config> = {}): Config => ({
  token: 't',
  owner: 'o',
  repo: 'r',
  workingDirectory: '/work',
  commitMessage: 'chore: update',
  commitPaths: [],
  commitAuthor: undefined,
  headBranch: 'bot/update',
  baseBranch: '',
  title: 'Update',
  body: undefined,
  labels: [],
  assignees: [],
  reviewers: [],
  teamReviewers: [],
  draft: false,
  closeIfEmpty: true,
  ...overrides,
});

const pr = { number: 7, html_url: 'https://github.com/o/r/pull/7', title: 'Update', body: 'old' };

const routes = {
  repo: (defaultBranch = 'main'): Route => ({ method: 'GET', path: '/repos/o/r', json: { default_branch: defaultBranch } }),
  branch: (name: string, sha: string | null, tree = BASE_TREE): Route[] =>
    sha === null
      ? [{ method: 'GET', path: `/repos/o/r/git/ref/heads/${name}`, status: 404, json: { message: 'Not Found' } }]
      : [
          { method: 'GET', path: `/repos/o/r/git/ref/heads/${name}`, json: { object: { sha } } },
          { method: 'GET', path: `/repos/o/r/git/commits/${sha}`, json: { tree: { sha: tree } } },
        ],
  known: (status = 200): Route => ({ method: 'GET', path: `/repos/o/r/git/commits/${LOCAL_HEAD}`, status, json: {} }),
  tree: (): Route => ({
    method: 'POST',
    path: '/repos/o/r/git/trees',
    status: 201,
    json: { sha: NEW_TREE },
    check: (req) => assert.deepEqual(req.json, { base_tree: BASE_TREE, tree: [{ path: 'a.txt', mode: '100644', type: 'blob', content: 'new\n' }] }),
  }),
  pulls: (list: unknown[]): Route => ({
    method: 'GET',
    path: '/repos/o/r/pulls',
    json: list,
    check: (req) => {
      assert.equal(req.url.searchParams.get('head'), 'o:bot/update');
      assert.equal(req.url.searchParams.get('base'), 'main');
      assert.equal(req.url.searchParams.get('state'), 'open');
    },
  }),
  commit: (author?: unknown): Route => ({
    method: 'POST',
    path: '/repos/o/r/git/commits',
    status: 201,
    json: { sha: COMMIT },
    check: (req) => assert.deepEqual(req.json, { message: 'chore: update', tree: NEW_TREE, parents: [BASE], ...(author ? { author } : {}) }),
  }),
  createRef: (status = 201): Route => ({
    method: 'POST',
    path: '/repos/o/r/git/refs',
    status,
    json: {},
    check: (req) => assert.deepEqual(req.json, { ref: 'refs/heads/bot/update', sha: COMMIT }),
  }),
  forceRef: (): Route => ({ method: 'PATCH', path: '/repos/o/r/git/refs/heads/bot/update', json: {}, check: (req) => assert.deepEqual(req.json, { sha: COMMIT, force: true }) }),
  createPull: (status = 201, body: unknown = { title: 'Update', head: 'bot/update', base: 'main', body: '', draft: false }): Route => ({
    method: 'POST',
    path: '/repos/o/r/pulls',
    status,
    json: status === 201 ? pr : { message: 'A pull request already exists for o:bot/update.' },
    check: (req) => assert.deepEqual(req.json, body),
  }),
};

const changed = () => fakeLocal({ 'a.txt': { data: 'new\n' } }, LOCAL_HEAD);
const clean = () => fakeLocal({}, LOCAL_HEAD);

async function execute(local: LocalState, list: Route[], overrides: Partial<Config> = {}) {
  const fake = fakeFetch(list);
  const warnings: string[] = [];
  const log: Log = { debug() {}, info() {}, warning: (m) => warnings.push(m), error() {} };
  const github = new GitHub({ token: 't', userAgent: 'test', apiUrl: 'https://api.github.com', fetch: fake.fetch, sleep: async () => {} });
  const outputs = await run(config(overrides), { github, log, local });
  fake.done();
  return { outputs, warnings };
}

describe('run', () => {
  it('creates the branch, commit and pull request with labels, assignees and reviewers', async () => {
    const { outputs } = await execute(
      changed(),
      [
        routes.repo(),
        ...routes.branch('main', BASE),
        routes.known(),
        routes.tree(),
        ...routes.branch('bot/update', null),
        routes.pulls([]),
        routes.commit({ name: 'Bot', email: 'bot@example.com' }),
        routes.createRef(),
        routes.createPull(201, { title: 'Update', head: 'bot/update', base: 'main', body: 'Body', draft: true }),
        { method: 'POST', path: '/repos/o/r/issues/7/labels', json: [], check: (req) => assert.deepEqual(req.json, { labels: ['deps'] }) },
        { method: 'POST', path: '/repos/o/r/issues/7/assignees', json: {}, check: (req) => assert.deepEqual(req.json, { assignees: ['alice'] }) },
        {
          method: 'POST',
          path: '/repos/o/r/pulls/7/requested_reviewers',
          status: 201,
          json: {},
          check: (req) => assert.deepEqual(req.json, { reviewers: ['bob'], team_reviewers: ['sre'] }),
        },
      ],
      {
        commitAuthor: { name: 'Bot', email: 'bot@example.com' },
        body: 'Body',
        draft: true,
        labels: ['deps'],
        assignees: ['alice'],
        reviewers: ['bob'],
        teamReviewers: ['sre'],
      },
    );
    assert.deepEqual(outputs, {
      'pr-number': 7,
      'pr-url': 'https://github.com/o/r/pull/7',
      'pr-operation': 'created',
      'pr-head-sha': COMMIT,
      'pr-head-branch': 'bot/update',
    });
  });

  it('force-updates an existing branch and pull request', async () => {
    const { outputs } = await execute(
      changed(),
      [
        routes.repo(),
        ...routes.branch('main', BASE),
        routes.known(),
        routes.tree(),
        ...routes.branch('bot/update', BRANCH, 'a'.repeat(40)),
        routes.pulls([pr]),
        routes.commit(),
        routes.forceRef(),
        { method: 'PATCH', path: '/repos/o/r/pulls/7', json: pr, check: (req) => assert.deepEqual(req.json, { title: 'New title' }) },
      ],
      { title: 'New title' },
    );
    assert.equal(outputs['pr-operation'], 'updated');
    assert.equal(outputs['pr-head-sha'], COMMIT);
  });

  it('leaves an up-to-date branch alone but syncs the body', async () => {
    const { outputs } = await execute(
      changed(),
      [
        routes.repo(),
        ...routes.branch('main', BASE),
        routes.known(),
        routes.tree(),
        ...routes.branch('bot/update', BRANCH, NEW_TREE),
        routes.pulls([pr]),
        { method: 'PATCH', path: '/repos/o/r/pulls/7', json: pr, check: (req) => assert.deepEqual(req.json, { body: 'new body' }) },
      ],
      { body: 'new body' },
    );
    assert.equal(outputs['pr-operation'], 'unchanged');
    assert.equal(outputs['pr-head-sha'], BRANCH);
  });

  it('does not patch an unchanged pull request when nothing differs', async () => {
    const { outputs } = await execute(changed(), [
      routes.repo(),
      ...routes.branch('main', BASE),
      routes.known(),
      routes.tree(),
      ...routes.branch('bot/update', BRANCH, NEW_TREE),
      routes.pulls([pr]),
    ]);
    assert.equal(outputs['pr-operation'], 'unchanged');
  });

  it('opens a pull request for an up-to-date branch without one', async () => {
    const { outputs } = await execute(changed(), [
      routes.repo(),
      ...routes.branch('main', BASE),
      routes.known(),
      routes.tree(),
      ...routes.branch('bot/update', BRANCH, NEW_TREE),
      routes.pulls([]),
      routes.createPull(),
    ]);
    assert.equal(outputs['pr-operation'], 'created');
    assert.equal(outputs['pr-head-sha'], BRANCH);
  });

  it('closes the pull request and deletes the branch when there is nothing left to change', async () => {
    const { outputs } = await execute(clean(), [
      routes.repo(),
      ...routes.branch('main', BASE),
      ...routes.branch('bot/update', BRANCH, 'a'.repeat(40)),
      routes.pulls([pr]),
      { method: 'PATCH', path: '/repos/o/r/pulls/7', json: {}, check: (req) => assert.deepEqual(req.json, { state: 'closed' }) },
      { method: 'DELETE', path: '/repos/o/r/git/refs/heads/bot/update', status: 204 },
    ]);
    assert.deepEqual(outputs, { 'pr-number': 7, 'pr-url': pr.html_url, 'pr-operation': 'closed', 'pr-head-sha': '', 'pr-head-branch': 'bot/update' });
  });

  it('deletes a leftover branch without a pull request', async () => {
    const { outputs } = await execute(clean(), [
      routes.repo(),
      ...routes.branch('main', BASE),
      ...routes.branch('bot/update', BRANCH),
      routes.pulls([]),
      { method: 'DELETE', path: '/repos/o/r/git/refs/heads/bot/update', status: 204 },
    ]);
    assert.equal(outputs['pr-operation'], 'closed');
    assert.equal(outputs['pr-number'], '');
  });

  it('skips when there is nothing to do', async () => {
    const none = await execute(clean(), [routes.repo(), ...routes.branch('main', BASE), ...routes.branch('bot/update', null), routes.pulls([])]);
    assert.equal(none.outputs['pr-operation'], 'skipped');

    const kept = await execute(clean(), [routes.repo(), ...routes.branch('main', BASE), ...routes.branch('bot/update', BRANCH), routes.pulls([pr])], { closeIfEmpty: false });
    assert.equal(kept.outputs['pr-operation'], 'skipped');
    assert.equal(kept.outputs['pr-number'], 7);
    assert.equal(kept.outputs['pr-head-sha'], BRANCH);
  });

  it('treats deletions already absent on the base as no change', async () => {
    const { outputs } = await execute(fakeLocal({ 'gone.txt': null }, LOCAL_HEAD), [
      routes.repo(),
      ...routes.branch('main', BASE),
      routes.known(),
      { method: 'GET', path: `/repos/o/r/git/trees/${BASE_TREE}`, json: { truncated: false, tree: [] } },
      ...routes.branch('bot/update', null),
      routes.pulls([]),
    ]);
    assert.equal(outputs['pr-operation'], 'skipped');
  });

  it('recovers when the branch or pull request appears concurrently', async () => {
    const { outputs, warnings } = await execute(
      changed(),
      [
        routes.repo(),
        ...routes.branch('main', BASE),
        routes.known(),
        routes.tree(),
        ...routes.branch('bot/update', null),
        routes.pulls([]),
        routes.commit(),
        routes.createRef(422),
        routes.forceRef(),
        routes.createPull(422),
        routes.pulls([{ ...pr, title: 'Old' }]),
        { method: 'PATCH', path: '/repos/o/r/pulls/7', json: pr, check: (req) => assert.deepEqual(req.json, { title: 'Update' }) },
        { method: 'POST', path: '/repos/o/r/pulls/7/requested_reviewers', status: 422, json: { message: 'Review cannot be requested from pull request author.' } },
      ],
      { reviewers: ['me'] },
    );
    assert.equal(outputs['pr-operation'], 'created');
    assert.deepEqual(warnings, ['Could not request reviewers: Review cannot be requested from pull request author.']);
  });

  it('fails when the pull request cannot be created', async () => {
    await assert.rejects(
      execute(changed(), [
        routes.repo(),
        ...routes.branch('main', BASE),
        routes.known(),
        routes.tree(),
        ...routes.branch('bot/update', null),
        routes.pulls([]),
        routes.commit(),
        routes.createRef(),
        routes.createPull(422),
        routes.pulls([]),
      ]),
      /could not create pull request: A pull request already exists/,
    );
  });

  it('guards the head branch, base branch and local commit', async () => {
    await assert.rejects(execute(clean(), [routes.repo()], { headBranch: 'main' }), /must differ from the base branch/);
    await assert.rejects(execute(clean(), [routes.repo()], { headBranch: 'main', baseBranch: 'dev' }), /must not be the default branch/);
    await assert.rejects(execute(clean(), [routes.repo(), ...routes.branch('main', null)]), /base branch 'main' does not exist/);
    await assert.rejects(execute(changed(), [routes.repo(), ...routes.branch('main', BASE), routes.known(404)]), /local commit f{40} is not on GitHub; push it first/);
  });
});
