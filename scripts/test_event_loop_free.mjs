// Regression guard: transcribing a long recording must NOT block the event loop.
//
// The split re-encodes, so it costs ~19.4s per 20 minutes of audio — about 70s
// for a 72-minute call. Run with spawnSync that froze the entire server for that
// whole stretch. That is not just a latency problem: the watchdog probes
// /api/health on an 8s timeout and kills node after three failures (~30s), so a
// long transcription would get its own server shot out from under it, and the
// recording would never finish processing.
//
// Measures two things while a real ffmpeg split runs:
//   1. event-loop lag  — how long the loop was unable to run a timer
//   2. HTTP latency    — what the watchdog would actually have observed
//
// Runs against a local stub via TRANSCRIBE_BASE_URL: real ffmpeg, no OpenAI, no cost.
// Run: node scripts/test_event_loop_free.mjs [minutes]
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';

const WATCHDOG_PROBE_TIMEOUT_MS = 8000; // what the watchdog gives up after

if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) {
  console.error('FAIL: ffmpeg not on PATH');
  process.exit(1);
}

const stub = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('stub transcript');
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));

// Stands in for /api/health: trivial work, so any latency here is the event loop
// being unavailable, exactly what the watchdog measures.
const probeTarget = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"ok":true}');
});
await new Promise((r) => probeTarget.listen(0, '127.0.0.1', r));
const probePort = probeTarget.address().port;

process.env.TRANSCRIBE_BASE_URL = `http://127.0.0.1:${stub.address().port}/v1`;
process.env.TRANSCRIBE_API_KEY = 'test-key';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-loop-'));

const { transcribeAudio } = await import('../server/transcribe.js');

const minutes = Number(process.argv[2] || 40);
const big = path.join(process.env.DATA_DIR, 'long.m4a');
console.log(`building a ${minutes}-minute recording…`);
assert.equal(spawnSync('ffmpeg', [
  '-f', 'lavfi', '-i', `sine=frequency=440:duration=${minutes * 60}`,
  '-c:a', 'aac', '-b:a', '128k', '-y', big,
], { stdio: 'ignore' }).status, 0);
const sizeMB = fs.statSync(big).size / 1048576;
assert.ok(sizeMB > 24, `need >24MB to trigger splitting, got ${sizeMB.toFixed(1)}MB`);
console.log(`  ${sizeMB.toFixed(1)} MB — over the cap, will be split\n`);

// --- instrument the loop ---
let maxLagMs = 0;
const PERIOD = 100;
let last = Date.now();
const lagTimer = setInterval(() => {
  const now = Date.now();
  maxLagMs = Math.max(maxLagMs, now - last - PERIOD);
  last = now;
}, PERIOD);

let maxHttpMs = 0;
let probes = 0;
const httpTimer = setInterval(() => {
  const t0 = Date.now();
  const req = http.get({ host: '127.0.0.1', port: probePort, path: '/' }, (res) => {
    res.resume();
    res.on('end', () => { maxHttpMs = Math.max(maxHttpMs, Date.now() - t0); probes++; });
  });
  req.on('error', () => {});
}, 500);

const started = Date.now();
await transcribeAudio(big, 'audio/mp4');
const elapsed = Date.now() - started;

clearInterval(lagTimer);
clearInterval(httpTimer);

console.log(`transcription (real split, stubbed Whisper) took ${(elapsed / 1000).toFixed(1)}s`);
console.log(`  max event-loop lag : ${maxLagMs} ms`);
console.log(`  max HTTP latency   : ${maxHttpMs} ms over ${probes} probes\n`);

let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok   ${name}`);
  else { console.error(`  FAIL ${name}`); failed++; }
}

// The split must dominate the runtime, or the test proved nothing.
check('the split actually ran long enough to matter (>5s)', elapsed > 5000);
check(`event loop never blocked beyond 1s (was ~${(elapsed / 1000).toFixed(0)}s when synchronous)`, maxLagMs < 1000);
check('a watchdog probe would never have timed out', maxHttpMs < WATCHDOG_PROBE_TIMEOUT_MS);
check('probes kept landing throughout the split', probes > 5);

stub.close();
probeTarget.close();
// The usage ledger holds the database open, and Windows won't delete an open file.
(await import('../server/db.js')).closeDb();
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

console.log(failed ? `\n${failed} FAILED` : '\n4/4 passed — the server stays responsive while a long recording is split');
process.exit(failed ? 1 : 0);
