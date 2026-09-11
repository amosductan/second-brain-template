// Integration test: the REAL >25MB chunking path. A long recording (an hour-plus
// call is the whole point of this app) exceeds Whisper's 25MB cap and has to be
// split by ffmpeg, transcribed segment by segment, and rejoined IN ORDER.
//
// This runs against a local stub via TRANSCRIBE_BASE_URL, so it exercises ffmpeg for
// real but costs nothing and never calls OpenAI. Each stub reply is numbered, so
// a mis-ordered join fails loudly instead of silently scrambling an hour of
// conversation — sorting "seg-10" before "seg-9" is exactly the kind of bug that
// only shows up past the tenth chunk.
//
// Run: node scripts/test_transcribe_chunking.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';

const ffmpegOk = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
if (!ffmpegOk) {
  console.error('FAIL: ffmpeg is not on PATH — long recordings cannot be transcribed at all.');
  process.exit(1);
}

// Stub: reply with the segment number it was asked for, in arrival order.
let served = 0;
const server = http.createServer((req, res) => {
  served++;
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`segment ${served}`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

process.env.TRANSCRIBE_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.TRANSCRIBE_API_KEY = 'test-key';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-chunk-'));

const { transcribeAudio } = await import('../server/transcribe.js');

// Build a real, decodable file longer than the segment size * 12, so the join
// has to order past segment 9 — where naive string sorting breaks.
const long = path.join(process.env.DATA_DIR, 'long.m4a');
const minutes = Number(process.argv[2] || 125); // 125 min -> ~13 segments
console.log(`building a ${minutes}-minute test recording...`);
const build = spawnSync('ffmpeg', [
  '-f', 'lavfi', '-i', `sine=frequency=440:duration=${minutes * 60}`,
  '-c:a', 'aac', '-b:a', '128k', '-y', long,
], { stdio: 'ignore' });
assert.equal(build.status, 0, 'ffmpeg could not build the test recording');

const sizeMB = fs.statSync(long).size / 1024 / 1024;
console.log(`  test file: ${sizeMB.toFixed(1)} MB`);
assert.ok(sizeMB > 24, `test file must exceed the 24MB cap, got ${sizeMB.toFixed(1)}MB`);

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { console.error(`  FAIL ${name}: ${err.message}`); process.exitCode = 1; }
}

const out = await transcribeAudio(long, 'audio/mp4');

check('file over the cap was split into multiple segments', () => {
  assert.ok(served > 1, `expected multiple segment uploads, got ${served}`);
});

check('every segment made it into the transcript', () => {
  for (let i = 1; i <= served; i++) {
    assert.ok(out.includes(`segment ${i}`), `segment ${i} missing from the joined transcript`);
  }
});

check('segments are joined in recording order (not string order)', () => {
  const order = [...out.matchAll(/segment (\d+)/g)].map((m) => Number(m[1]));
  const expected = [...order].sort((a, b) => a - b);
  assert.deepEqual(order, expected, `segments out of order: ${order.join(',')}`);
});

check('past segment 9, so double-digit ordering is actually covered', () => {
  assert.ok(served >= 10, `only ${served} segments — raise the duration to cover 2-digit ordering`);
});

console.log(`\n${passed}/4 passed — ${served} segments, ${sizeMB.toFixed(1)}MB input`);
server.close();
// The usage ledger holds the database open, and Windows won't delete an open file.
(await import('../server/db.js')).closeDb();
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
