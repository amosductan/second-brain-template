// Integration test: the REAL transcribe path retries a 503 and fails fast on a
// 400. Runs against a local stub (via TRANSCRIBE_BASE_URL) so it costs nothing and
// never touches OpenAI. Run: node scripts/test_transcribe_retry.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';

// A scripted stub: each request pops the next response off the plan.
let plan = [];
let hits = 0;
const server = http.createServer((req, res) => {
  hits++;
  const next = plan.shift() || { status: 200, body: 'fallback' };
  res.writeHead(next.status, { 'Content-Type': 'text/plain' });
  res.end(next.body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

process.env.TRANSCRIBE_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.TRANSCRIBE_API_KEY = 'test-key';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-test-'));

const { transcribeAudio } = await import('../server/transcribe.js');

const audio = path.join(process.env.DATA_DIR, 'clip.m4a');
fs.writeFileSync(audio, Buffer.alloc(2048, 7)); // the stub doesn't read it

let passed = 0;
async function check(name, fn) {
  hits = 0;
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { console.error(`  FAIL ${name}: ${err.message}`); process.exitCode = 1; }
}

await check('two 503s then success -> transcript returned, 3 requests made', async () => {
  plan = [
    { status: 503, body: 'upstream busy' },
    { status: 503, body: 'upstream busy' },
    { status: 200, body: '  hello from the stub  ' },
  ];
  const out = await transcribeAudio(audio, 'audio/mp4');
  assert.equal(out, 'hello from the stub');
  assert.equal(hits, 3, `expected 3 requests, saw ${hits}`);
});

await check('429 then success -> retried', async () => {
  plan = [{ status: 429, body: 'rate limited' }, { status: 200, body: 'second try' }];
  assert.equal(await transcribeAudio(audio, 'audio/mp4'), 'second try');
  assert.equal(hits, 2, `expected 2 requests, saw ${hits}`);
});

await check('400 bad audio -> fails immediately, exactly 1 request (no wasted retries)', async () => {
  plan = [{ status: 400, body: '{"error":"audio_too_short"}' }];
  await assert.rejects(() => transcribeAudio(audio, 'audio/mp4'), /Transcription failed \(400\)/);
  assert.equal(hits, 1, `expected 1 request, saw ${hits}`);
});

await check('persistent 500 -> gives up after 3 requests with a clear error', async () => {
  plan = [
    { status: 500, body: 'boom' }, { status: 500, body: 'boom' },
    { status: 500, body: 'boom' }, { status: 500, body: 'boom' },
  ];
  await assert.rejects(() => transcribeAudio(audio, 'audio/mp4'), /Transcription failed \(500\)/);
  assert.equal(hits, 3, `expected 3 requests, saw ${hits}`);
});

await check('connection refused (server gone) -> retried, then a network error', async () => {
  await new Promise((r) => server.close(r));
  await assert.rejects(() => transcribeAudio(audio, 'audio/mp4'), /fetch failed/i);
});

// The usage ledger holds the database open, and Windows won't delete an open file.
(await import('../server/db.js')).closeDb();
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(`\n${passed} checks passed${process.exitCode ? ' — WITH FAILURES' : ''}`);
