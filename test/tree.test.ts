import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Log } from '../src/lib/actions.ts';
import { GitHub } from '../src/lib/github.ts';
import { BLOB_MAX, buildEntries, INLINE_MAX, INLINE_TOTAL_MAX, inlineText, mapLimit } from '../src/tree.ts';
import { fakeFetch, type Route } from './helpers/fake-fetch.ts';
import { blobSha, fakeLocal } from './helpers/local.ts';
import type { LocalState } from '../src/changes.ts';

const BASE_TREE = '1'.repeat(40);

async function build(local: LocalState, routes: Route[]) {
  const fake = fakeFetch(routes);
  const infos: string[] = [];
  const log: Log = { debug() {}, info: (m) => infos.push(m), warning() {}, error() {} };
  const github = new GitHub({ token: 't', userAgent: 'test', apiUrl: 'https://api.github.com', fetch: fake.fetch, sleep: async () => {} });
  try {
    return { entries: await buildEntries(github, '/repos/o/r', BASE_TREE, local, log), infos };
  } finally {
    fake.done();
  }
}

const blobRoute = (data: Buffer, sha = blobSha(data)): Route => ({
  method: 'POST',
  path: '/repos/o/r/git/blobs',
  status: 201,
  json: { sha },
  check: (req) => assert.deepEqual(req.json, { content: data.toString('base64'), encoding: 'base64' }),
});

describe('inlineText', () => {
  it('accepts exact UTF-8 text only', () => {
    assert.equal(inlineText(Buffer.from('héllo\r\n')), 'héllo\r\n');
    assert.equal(inlineText(Buffer.from('﻿bom')), '﻿bom');
    assert.equal(inlineText(Buffer.from([0x61, 0x00])), undefined);
    assert.equal(inlineText(Buffer.from([0xff, 0xfe])), undefined);
    assert.equal(inlineText(Buffer.alloc(INLINE_MAX + 1, 'a')), undefined);
  });
});

describe('mapLimit', () => {
  it('keeps order and bounds concurrency', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 3, 2], 2, async (n) => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, n));
      active--;
      return n * 10;
    });
    assert.deepEqual(out, [50, 10, 30, 20]);
    assert.equal(peak, 2);
  });
});

describe('buildEntries', () => {
  it('inlines text and uploads binaries and symlinks as verified blobs', async () => {
    const binary = Buffer.from([0, 1, 2, 3]);
    const { entries } = await build(
      fakeLocal({ 'a.txt': { data: 'text\n' }, 'bin.dat': { data: binary, mode: '100755' }, link: { data: 'a.txt', mode: '120000' } }),
      [blobRoute(binary), blobRoute(Buffer.from('a.txt'))],
    );
    assert.deepEqual(entries, [
      { path: 'a.txt', mode: '100644', type: 'blob', content: 'text\n' },
      { path: 'bin.dat', mode: '100755', type: 'blob', sha: blobSha(binary) },
      { path: 'link', mode: '120000', type: 'blob', sha: blobSha(Buffer.from('a.txt')) },
    ]);
  });

  it('caps the total inline size', async () => {
    const chunk = Buffer.alloc(INLINE_MAX, 'a');
    const files = Object.fromEntries(Array.from({ length: INLINE_TOTAL_MAX / INLINE_MAX + 1 }, (_, i) => [`f${i}`, { data: chunk }]));
    const { entries } = await build(fakeLocal(files), [blobRoute(chunk)]);
    assert.equal(entries.filter((e) => e.content !== undefined).length, INLINE_TOTAL_MAX / INLINE_MAX);
    assert.equal(entries.filter((e) => e.sha).length, 1);
  });

  it('deletes only files that exist on the base, walking only relevant directories', async () => {
    const { entries, infos } = await build(fakeLocal({ 'gone.txt': null, 'a/b/c.txt': null, 'a/missing.txt': null, 'x/y.txt': null, 'dir': null }), [
      {
        method: 'GET',
        path: `/repos/o/r/git/trees/${BASE_TREE}`,
        json: {
          truncated: false,
          tree: [
            { path: 'gone.txt', type: 'blob', sha: '2'.repeat(40) },
            { path: 'a', type: 'tree', sha: 'a'.repeat(40) },
            { path: 'dir', type: 'tree', sha: 'd'.repeat(40) },
            { path: 'other', type: 'tree', sha: 'e'.repeat(40) },
          ],
        },
      },
      { method: 'GET', path: `/repos/o/r/git/trees/${'a'.repeat(40)}`, json: { truncated: false, tree: [{ path: 'b', type: 'tree', sha: 'b'.repeat(40) }] } },
      { method: 'GET', path: `/repos/o/r/git/trees/${'b'.repeat(40)}`, json: { truncated: false, tree: [{ path: 'c.txt', type: 'blob', sha: '3'.repeat(40) }] } },
    ]);
    assert.deepEqual(entries, [
      { path: 'gone.txt', mode: '100644', type: 'blob', sha: null },
      { path: 'a/b/c.txt', mode: '100644', type: 'blob', sha: null },
    ]);
    assert.deepEqual(infos.sort(), ["'a/missing.txt' is already absent on the base branch", "'dir' is already absent on the base branch", "'x/y.txt' is already absent on the base branch"]);
  });

  it('fails on truncated trees, oversized files and mismatched uploads', async () => {
    await assert.rejects(build(fakeLocal({ x: null }), [{ method: 'GET', path: `/repos/o/r/git/trees/${BASE_TREE}`, json: { truncated: true, tree: [] } }]), /too large to inspect/);
    await assert.rejects(build(fakeLocal({ big: { data: Buffer.alloc(BLOB_MAX + 1) } }), []), /larger than GitHub's 100 MiB/);
    const binary = Buffer.from([0]);
    await assert.rejects(build(fakeLocal({ b: { data: binary } }), [blobRoute(binary, '9'.repeat(40))]), /uploaded 'b' as 9{40}, expected/);
  });
});
