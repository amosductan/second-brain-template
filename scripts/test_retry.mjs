// Self-test for server/retry.js — the classifier is the whole safety property:
// retry a blip, never retry a real reject. Run: node scripts/test_retry.mjs
import assert from 'node:assert';
import { isTransientError, terminal, withRetry } from '../server/retry.js';

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { console.error(`  FAIL ${name}: ${err.message}`); process.exitCode = 1; }
}
async function checkAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { console.error(`  FAIL ${name}: ${err.message}`); process.exitCode = 1; }
}

const withStatus = (status) => Object.assign(new Error(`http ${status}`), { status });

console.log('classification — transient:');
for (const s of [429, 500, 502, 503, 504, 408]) {
  check(`status ${s}`, () => assert.equal(isTransientError(withStatus(s)), true));
}
check('fetch failed (node network error)', () =>
  assert.equal(isTransientError(new TypeError('fetch failed')), true));
check('ECONNRESET by code', () =>
  assert.equal(isTransientError(Object.assign(new Error('boom'), { code: 'ECONNRESET' })), true));
check('Anthropic APIConnectionError', () =>
  assert.equal(isTransientError(Object.assign(new Error('conn'), { name: 'APIConnectionError' })), true));

console.log('classification — terminal:');
for (const s of [400, 401, 403, 404, 413, 422]) {
  check(`status ${s}`, () => assert.equal(isTransientError(withStatus(s)), false));
}
check('explicitly terminal wins over a 503 status', () =>
  assert.equal(isTransientError(terminal(withStatus(503))), false));
check('missing-key error (no status, plain message)', () =>
  assert.equal(isTransientError(terminal(new Error('No transcription key is set'))), false));
check('a plain programming error is not retried', () =>
  assert.equal(isTransientError(new TypeError("Cannot read properties of undefined")), false));

console.log('behavior:');
await checkAsync('succeeds on the 3rd attempt after two 503s', async () => {
  let n = 0;
  const out = await withRetry('t', async () => {
    n++;
    if (n < 3) throw withStatus(503);
    return 'transcript';
  }, { baseDelay: 5 });
  assert.equal(out, 'transcript');
  assert.equal(n, 3, `expected 3 attempts, made ${n}`);
});

await checkAsync('gives up after the attempt cap and rethrows the last error', async () => {
  let n = 0;
  await assert.rejects(
    () => withRetry('t', async () => { n++; throw withStatus(500); }, { baseDelay: 5 }),
    /http 500/);
  assert.equal(n, 3, `expected 3 attempts, made ${n}`);
});

await checkAsync('a 400 fails immediately — exactly one attempt', async () => {
  let n = 0;
  await assert.rejects(
    () => withRetry('t', async () => { n++; throw withStatus(400); }, { baseDelay: 5 }),
    /http 400/);
  assert.equal(n, 1, `expected 1 attempt, made ${n}`);
});

await checkAsync('backoff actually grows (1x then 2x)', async () => {
  const delays = [];
  let n = 0;
  await assert.rejects(() => withRetry('t', async () => { n++; throw withStatus(503); }, {
    baseDelay: 40, onRetry: (_a, d) => delays.push(d),
  }));
  assert.equal(delays.length, 2, `expected 2 waits, got ${delays.length}`);
  assert.ok(delays[1] > delays[0], `expected growth, got ${delays.join(' -> ')}`);
});

console.log(`\n${passed} checks passed${process.exitCode ? ' — WITH FAILURES' : ''}`);
