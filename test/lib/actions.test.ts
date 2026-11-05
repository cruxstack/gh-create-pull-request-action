import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { formatOutputs, InputError, Inputs, Runtime, runAction } from '../../src/lib/actions.ts';
import { parseOutputs } from '../helpers/action.ts';

const inputs = (env: Record<string, string>) => new Inputs(env);

describe('Inputs', () => {
  it('reads and trims INPUT_ variables, keeping hyphens', () => {
    assert.equal(inputs({ 'INPUT_GITHUB-TOKEN': '  abc \n' }).get('github-token'), 'abc');
    assert.equal(inputs({}).get('missing'), '');
  });

  it('applies string fallbacks and required checks', () => {
    assert.equal(inputs({}).string('x', 'y'), 'y');
    assert.throws(() => inputs({}).required('pr-title'), (e) => e instanceof InputError && e.input === 'pr-title');
  });

  it('parses booleans strictly', () => {
    assert.equal(inputs({ INPUT_A: 'TRUE' }).boolean('a', false), true);
    assert.equal(inputs({ INPUT_A: 'false' }).boolean('a', true), false);
    assert.equal(inputs({}).boolean('a', true), true);
    assert.throws(() => inputs({ INPUT_A: 'yes' }).boolean('a', false), /must be 'true' or 'false'/);
  });

  it('validates choices', () => {
    assert.equal(inputs({ INPUT_A: 'b' }).choice('a', ['a', 'b'], 'a'), 'b');
    assert.equal(inputs({}).choice('a', ['a', 'b'], 'a'), 'a');
    assert.throws(() => inputs({ INPUT_A: 'c' }).choice('a', ['a', 'b'], 'a'), /one of a, b/);
  });

  it('splits lists on newlines and optionally commas', () => {
    assert.deepEqual(inputs({ INPUT_A: 'x, y\n\n z \r\nw' }).list('a'), ['x, y', 'z', 'w']);
    assert.deepEqual(inputs({ INPUT_A: 'x, y\nz' }).list('a', { commas: true }), ['x', 'y', 'z']);
    assert.deepEqual(inputs({}).list('a'), []);
  });
});

describe('formatOutputs', () => {
  it('writes heredoc entries', () => {
    const text = formatOutputs({ a: 'one\ntwo', b: true, c: 3 }, 'EOF');
    assert.equal(text, 'a<<EOF\none\ntwo\nEOF\nb<<EOF\ntrue\nEOF\nc<<EOF\n3\nEOF\n');
    assert.deepEqual(parseOutputs(text), { a: 'one\ntwo', b: 'true', c: '3' });
  });

  it('rejects values containing the delimiter', () => {
    assert.throws(() => formatOutputs({ a: 'x EOF' }, 'EOF'), /contains the delimiter/);
  });

  it('uses a random delimiter by default', () => {
    assert.match(formatOutputs({ a: '' }), /^a<<ghadelimiter_[0-9a-f-]{36}\n/);
  });
});

describe('Runtime', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    process.exitCode = 0;
  });

  const capture = (env: Record<string, string> = {}) => {
    const lines: string[] = [];
    return { rt: new Runtime(env, (l) => lines.push(l)), lines };
  };

  it('masks each line of a secret', () => {
    const { rt, lines } = capture();
    rt.mask('abc\n\nd%f');
    assert.deepEqual(lines, ['::add-mask::abc', '::add-mask::d%25f']);
  });

  it('escapes annotations and only prints debug when enabled', () => {
    const quiet = capture();
    quiet.rt.log.debug('hidden');
    quiet.rt.log.warning('a\nb');
    quiet.rt.log.error('c');
    quiet.rt.log.info('plain');
    assert.deepEqual(quiet.lines, ['::warning::a%0Ab', '::error::c', 'plain']);
    const loud = capture({ RUNNER_DEBUG: '1' });
    loud.rt.log.debug('shown');
    assert.deepEqual(loud.lines, ['::debug::shown']);
  });

  it('appends outputs to GITHUB_OUTPUT', () => {
    dir = mkdtempSync(join(tmpdir(), 'rt-'));
    const file = join(dir, 'out');
    writeFileSync(file, 'x<<D\n1\nD\n');
    capture({ GITHUB_OUTPUT: file }).rt.setOutputs({ y: '2' });
    assert.deepEqual(parseOutputs(readFileSync(file, 'utf8')), { x: '1', y: '2' });
  });

  it('requires GITHUB_OUTPUT', () => {
    assert.throws(() => capture().rt.setOutputs({ a: '1' }), /GITHUB_OUTPUT is not set/);
  });

  it('runAction writes outputs on success and fails the step on error', async () => {
    dir = mkdtempSync(join(tmpdir(), 'rt-'));
    const file = join(dir, 'out');
    writeFileSync(file, '');
    const ok = capture({ GITHUB_OUTPUT: file });
    await runAction(async () => ({ done: true }), ok.rt);
    assert.deepEqual(parseOutputs(readFileSync(file, 'utf8')), { done: 'true' });
    assert.notEqual(process.exitCode, 1);

    const bad = capture({ GITHUB_OUTPUT: file });
    await runAction(async () => {
      throw new Error('boom');
    }, bad.rt);
    assert.equal(process.exitCode, 1);
    assert.deepEqual(bad.lines, ['::error::boom']);
  });
});
