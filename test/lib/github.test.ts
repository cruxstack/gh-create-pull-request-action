import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { API_VERSION, GitHub, GitHubError, nextLink, path, type GitHubOptions } from '../../src/lib/github.ts';
import { fakeFetch, type Route } from '../helpers/fake-fetch.ts';

function client(routes: Route[], options: Partial<GitHubOptions> = {}) {
  const fake = fakeFetch(routes);
  const sleeps: number[] = [];
  const warnings: string[] = [];
  const github = new GitHub({
    token: 'secret-token',
    userAgent: 'test-agent',
    apiUrl: 'https://api.github.com',
    fetch: fake.fetch,
    sleep: async (ms) => void sleeps.push(ms),
    log: { debug() {}, info() {}, warning: (m) => warnings.push(m), error() {} },
    ...options,
  });
  return { github, fake, sleeps, warnings };
}

describe('path', () => {
  it('encodes values but keeps slashes', () => {
    assert.equal(path`/repos/${'o'}/${'r'}/git/ref/tags/${'v1.0.0+b/x y'}`, '/repos/o/r/git/ref/tags/v1.0.0%2Bb/x%20y');
  });

  it('rejects dot segments', () => {
    assert.throws(() => path`/repos/${'..'}/x`, /unsafe path segment/);
    assert.throws(() => path`/git/ref/${'tags/../heads'}`, /unsafe path segment/);
  });
});

describe('nextLink', () => {
  it('finds the next page', () => {
    assert.equal(nextLink('<https://api.github.com/x?page=1>; rel="prev", <https://api.github.com/x?page=3>; rel="next"'), 'https://api.github.com/x?page=3');
    assert.equal(nextLink('<https://api.github.com/x?page=1>; rel="prev"'), undefined);
    assert.equal(nextLink(null), undefined);
  });
});

describe('GitHub', () => {
  it('sends auth, version and JSON headers', async () => {
    const { github, fake } = client([
      {
        method: 'POST',
        path: '/repos/o/r/things',
        status: 201,
        json: { id: 1 },
        check: (req) => {
          assert.equal(req.headers.get('authorization'), 'Bearer secret-token');
          assert.equal(req.headers.get('x-github-api-version'), API_VERSION);
          assert.equal(req.headers.get('user-agent'), 'test-agent');
          assert.equal(req.headers.get('accept'), 'application/vnd.github+json');
          assert.deepEqual(req.json, { a: 1 });
          assert.equal(req.url.searchParams.get('q'), 'x');
        },
      },
    ]);
    const res = await github.request<{ id: number }>('POST', '/repos/o/r/things', { body: { a: 1 }, query: { q: 'x', skip: undefined } });
    assert.deepEqual(res.data, { id: 1 });
    fake.done();
  });

  it('sends raw bodies with a content type', async () => {
    const { github, fake } = client([
      { method: 'POST', path: '/upload', check: (req) => (assert.equal(req.body, 'abc'), assert.equal(req.headers.get('content-type'), 'text/plain')) },
    ]);
    await github.request('POST', '/upload', { data: 'abc', contentType: 'text/plain' });
    fake.done();
  });

  it('returns null for empty bodies and text for non-JSON', async () => {
    const { github, fake } = client([
      { method: 'DELETE', path: '/a', status: 204 },
      { method: 'GET', path: '/b', body: 'plain', headers: { 'content-type': 'text/plain' } },
    ]);
    assert.equal((await github.request('DELETE', '/a')).data, null);
    assert.equal((await github.request('GET', '/b')).data, 'plain');
    fake.done();
  });

  it('only allows https or loopback API URLs', () => {
    assert.throws(() => new GitHub({ token: 't', userAgent: 'u', apiUrl: 'http://example.com' }), /non-https/);
    assert.doesNotThrow(() => new GitHub({ token: 't', userAgent: 'u', apiUrl: 'http://127.0.0.1:8080' }));
  });

  it('never sends the token to other origins', async () => {
    const { github } = client([]);
    await assert.rejects(github.request('GET', 'https://evil.example/x'), /refusing to send credentials/);
    assert.equal(github.url('https://uploads.github.com/a').origin, 'https://uploads.github.com');
    const ghes = new GitHub({ token: 't', userAgent: 'u', apiUrl: 'https://ghe.example/api/v3/' });
    assert.equal(ghes.url('/repos').href, 'https://ghe.example/api/v3/repos');
    assert.throws(() => ghes.url('https://uploads.github.com/a'), /refusing/);
  });

  it('follows pagination links', async () => {
    const { github, fake } = client([
      {
        method: 'GET',
        path: '/items',
        json: [1, 2],
        headers: { link: '<https://api.github.com/items2?page=2>; rel="next"' },
        check: (req) => assert.equal(req.url.searchParams.get('per_page'), '100'),
      },
      { method: 'GET', path: '/items2', json: { values: [3] } },
    ]);
    const seen: number[] = [];
    for await (const n of github.paginate<number>('/items', {}, (page) => (Array.isArray(page) ? page : (page as { values: number[] }).values))) seen.push(n);
    assert.deepEqual(seen, [1, 2, 3]);
    fake.done();
  });

  it('retries idempotent requests on server errors', async () => {
    const { github, fake, sleeps, warnings } = client([
      { method: 'GET', path: '/a', status: 502, times: 2 },
      { method: 'GET', path: '/a', json: { ok: true } },
    ]);
    assert.deepEqual((await github.request('GET', '/a')).data, { ok: true });
    assert.equal(sleeps.length, 2);
    assert.ok(sleeps[0]! >= 500 && sleeps[0]! <= 1000);
    assert.match(warnings[0]!, /HTTP 502; retry 1\/3/);
    fake.done();
  });

  it('does not retry POST on server errors unless idempotent', async () => {
    const { github, fake } = client([{ method: 'POST', path: '/a', status: 500, json: { message: 'oops' } }]);
    await assert.rejects(github.request('POST', '/a'), (e) => e instanceof GitHubError && e.status === 500);
    fake.done();

    const retried = client([
      { method: 'POST', path: '/a', status: 503 },
      { method: 'POST', path: '/a', status: 201 },
    ]);
    assert.equal((await retried.github.request('POST', '/a', { idempotent: true })).status, 201);
    retried.fake.done();
  });

  it('gives up after the retry budget', async () => {
    const { github, fake } = client([{ method: 'GET', path: '/a', status: 503, times: 2 }], { maxRetries: 1 });
    await assert.rejects(github.request('GET', '/a'), /failed with 503/);
    fake.done();
  });

  it('retries rate limits for any method, honoring retry-after', async () => {
    const { github, fake, sleeps } = client([
      { method: 'POST', path: '/a', status: 429, headers: { 'retry-after': '3' } },
      { method: 'POST', path: '/a', status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 5) } },
      { method: 'POST', path: '/a', status: 201 },
    ]);
    assert.equal((await github.request('POST', '/a')).status, 201);
    assert.equal(sleeps[0], 3000);
    assert.ok(sleeps[1]! > 3000 && sleeps[1]! <= 6000);
    fake.done();
  });

  it('fails fast when the rate limit wait is too long', async () => {
    const { github, fake } = client([{ method: 'GET', path: '/a', status: 429, headers: { 'retry-after': '120' } }]);
    await assert.rejects(github.request('GET', '/a'), /failed with 429/);
    fake.done();
  });

  it('does not retry plain 403s', async () => {
    const { github, fake } = client([{ method: 'GET', path: '/a', status: 403, json: { message: 'Resource not accessible by integration' } }]);
    await assert.rejects(github.request('GET', '/a'), /403: Resource not accessible by integration/);
    fake.done();
  });

  it('retries network errors only for idempotent requests', async () => {
    let calls = 0;
    const flaky: typeof fetch = async () => {
      if (calls++ === 0) throw new TypeError('socket hang up');
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    };
    const { github } = client([], { fetch: flaky });
    assert.deepEqual((await github.request('GET', '/a')).data, {});
    calls = 0;
    await assert.rejects(github.request('POST', '/a'), (e) => e instanceof GitHubError && e.status === 0 && /socket hang up/.test(e.message));
  });

  it('returns allowed error statuses', async () => {
    const { github, fake } = client([{ method: 'GET', path: '/a', status: 404, json: { message: 'Not Found' } }]);
    const res = await github.request<{ message: string }>('GET', '/a', { allowStatus: [404] });
    assert.equal(res.status, 404);
    assert.equal(res.data.message, 'Not Found');
    fake.done();
  });

  it('builds descriptive errors', async () => {
    const { github, fake } = client([
      {
        method: 'POST',
        path: '/a',
        status: 422,
        json: { message: 'Validation Failed', errors: [{ message: 'already exists' }, { field: 'sha', code: 'missing' }] },
        headers: { 'x-github-request-id': 'ABC:123' },
      },
      { method: 'GET', path: '/b', status: 500, body: 'upstream', headers: { 'content-type': 'text/plain' } },
    ]);
    await assert.rejects(github.request('POST', '/a'), {
      message: 'POST /a failed with 422: Validation Failed; already exists; sha missing (request ABC:123)',
      requestId: 'ABC:123',
    });
    await assert.rejects(github.request('GET', '/b', { idempotent: false }), /500: upstream/);
    fake.done();
  });
});
