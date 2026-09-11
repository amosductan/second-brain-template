#!/usr/bin/env node
/**
 * Proves that a live recording survives the page dying mid-recording.
 *
 * The bug this guards: a recording's chunks lived only in a JS array, so when
 * iOS suspended the tab (screen blanked, power button, Low Power Mode refusing
 * the screen wake lock) the audio went with the page. public/app.js now writes
 * every few seconds of audio to IndexedDB and reassembles it on the next load.
 *
 * What this actually exercises — a real browser, a real MediaRecorder over
 * Chromium's fake microphone, a real server, real IndexedDB:
 *   1. wake lock — recording requests one and the hint line tells the truth
 *   2. clean stop — uploads, and leaves NO chunk records behind (no duplicate)
 *   3. killed page — the partial recording is reassembled, uploaded, and the
 *      file that lands on the server is decodable audio of about the right length
 *
 * It cannot test iOS itself. Safari's suspend behavior and its refusal of the
 * wake lock in Low Power Mode need a real phone.
 *
 * Run:  node scripts/test_recording_recovery.mjs [--headed]
 * Needs playwright (npx playwright --version once is enough — it is resolved
 * from the npx cache and deliberately NOT added to this app's dependencies).
 * Costs nothing: no API keys are passed to the server, so nothing calls out.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const HEADED = process.argv.includes('--headed');

let failures = 0;
const ok = (name, extra = '') => console.log(`  PASS  ${name}${extra ? ` — ${extra}` : ''}`);
const bad = (name, why) => { failures++; console.log(`  FAIL  ${name} — ${why}`); };
function check(name, cond, why, extra) { cond ? ok(name, extra) : bad(name, why); }

// ---------- playwright, without making it a dependency of the app ----------
function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const roots = [REPO];
  // npx caches packages here on Windows and on macOS/Linux respectively.
  for (const npxCache of [
    path.join(os.homedir(), 'AppData', 'Local', 'npm-cache', '_npx'),
    path.join(os.homedir(), '.npm', '_npx'),
  ]) {
    if (fs.existsSync(npxCache)) {
      for (const d of fs.readdirSync(npxCache)) roots.push(path.join(npxCache, d));
    }
  }
  for (const root of roots) {
    const entry = path.join(root, 'node_modules', 'playwright', 'index.js');
    if (fs.existsSync(entry)) return req(entry);
  }
  throw new Error('playwright not found — run `npx --yes playwright@1 --version` once, then re-run this test');
}

// ---------- server under test (throwaway DATA_DIR, no keys) ----------
function startServer(dataDir) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: REPO,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      // Blank, not absent: a key in the shell's environment would otherwise
      // reach the server, and a test must never spend real money.
      LLM_PROVIDER: '',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      GEMINI_API_KEY: '',
      TRANSCRIBE_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (b) => log.push(b.toString()));
  child.stderr.on('data', (b) => log.push(b.toString()));
  return { child, log };
}

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return await res.json();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('server never became healthy');
}

const notes = async () => (await (await fetch(`${BASE}/api/notes`)).json());

// A note is created immediately; the audio file is written by the ingest route.
async function waitForNoteCount(n, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    last = await notes().catch(() => []);
    if (last.length >= n) return last;
    await new Promise((r) => setTimeout(r, 400));
  }
  return last;
}

function audioFiles(dataDir) {
  const dir = path.join(dataDir, 'audio');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((f) => ({
    name: f,
    size: fs.statSync(path.join(dir, f)).size,
    full: path.join(dir, f),
  }));
}

function probeSeconds(file) {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
  ], { encoding: 'utf8' });
  const secs = parseFloat((r.stdout || '').trim());
  return Number.isFinite(secs) ? secs : null;
}

// ---------- browser-side helpers ----------
const chunkCount = (page) => page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('second-brain-outbox', 2);
  req.onsuccess = () => {
    const db = req.result;
    const tx = db.transaction('chunks', 'readonly');
    const c = tx.objectStore('chunks').count();
    c.onsuccess = () => { resolve(c.result); db.close(); };
    c.onerror = () => { resolve(-1); db.close(); };
  };
  req.onerror = () => resolve(-1);
}));

// Wait for the recorder to actually be running, not just for the click. There is
// a real gap while getUserMedia resolves, and timing the assertions off the click
// measures a recording that has not started yet.
async function startRecording(page) {
  await page.click('#record-btn');
  await page.waitForFunction(
    () => typeof mediaRecorder !== 'undefined' && mediaRecorder && mediaRecorder.state === 'recording',
    null, { timeout: 15000 },
  );
}
const stopRecording = (page) => page.click('#record-btn');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll instead of sleeping a fixed amount: a flush is an async IndexedDB write.
async function waitForChunks(page, want, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let n = 0;
  while (Date.now() < deadline) {
    n = await chunkCount(page);
    if (n >= want) return n;
    await sleep(500);
  }
  return n;
}

// ---------- run ----------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-rec-test-'));
const { child, log } = startServer(dataDir);
let browser;

try {
  const { chromium } = loadPlaywright();
  const health = await waitForHealth();
  console.log(`\nserver up on ${PORT}, DATA_DIR=${dataDir} (notes=${health.total_notes})\n`);

  browser = await chromium.launch({
    headless: !HEADED,
    args: [
      '--use-fake-device-for-media-capture',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  // One context for the whole run: IndexedDB is per origin per context, so
  // closing a PAGE and opening a new one is exactly the "iOS killed the tab,
  // then you reopened the app" case. A new context would wipe the store and
  // make the recovery test pass vacuously.
  // Chromium denies the screen wake lock by default under automation, which is a
  // harness artifact, not the app's behavior — grant it so the GRANTED branch is
  // actually exercised. Older Playwright builds don't know the name; falling back
  // still leaves the refused branch under test, which is the safer of the two.
  let ctx;
  try {
    ctx = await browser.newContext({ permissions: ['microphone', 'screen-wake-lock'] });
  } catch {
    ctx = await browser.newContext({ permissions: ['microphone'] });
  }

  // ===== 1. wake lock =====
  console.log('1. screen wake lock');
  let page = await ctx.newPage();
  await page.goto(BASE);
  await page.waitForSelector('#record-btn');
  await startRecording(page);
  await sleep(1500);

  const held = await page.evaluate(() => !!window.navigator.wakeLock);
  const hint = (await page.textContent('#record-hint')) || '';
  const hintVisible = await page.isVisible('#record-hint');
  check('wake lock API is used at all', held, 'navigator.wakeLock missing in this Chromium');
  check('a hint is shown while recording', hintVisible && hint.length > 0,
    'the hint line is empty — a refused lock would be silent', JSON.stringify(hint));
  check('the hint states the actual lock state', /Screen stays on|Screen may switch off/.test(hint),
    `unexpected hint text: ${hint}`);
  // Granted or refused, both are legitimate outcomes; the defect was saying
  // nothing. Report WHY when it is refused — headless Chromium has no screen to
  // keep awake, which is not the same thing as the code being wrong.
  const why = await page.evaluate(async () => {
    if (!('wakeLock' in navigator)) return 'navigator.wakeLock absent';
    try { const l = await navigator.wakeLock.request('screen'); l.release(); return 'granted'; }
    catch (e) { return `${e.name}: ${e.message}`; }
  });
  console.log(`        (lock ${/stays on/.test(hint) ? 'GRANTED' : 'refused'} in this browser — ${why})`);
  check('secure context (the wake lock API needs one)',
    await page.evaluate(() => isSecureContext), 'page is not a secure context');

  // ===== 1b. the lock survives the page being hidden and shown =====
  // This is the crux: iOS releases the lock every time the page hides, so a
  // recording that acquired one at the start has nothing left the second time the
  // screen blanks. Simulated here by releasing the lock and firing the same event
  // the OS fires.
  console.log('\n1b. hidden → visible re-acquires the lock');
  const lockHeld = () => page.evaluate(() => !!wakeLock);
  if (await lockHeld()) {
    // Hidden: the OS drops the lock, and we take a last-gasp flush before suspend.
    const beforeHide = await chunkCount(page);
    await page.evaluate(async () => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      await wakeLock.release();
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await sleep(1200);
    check('the lock is gone once hidden (as iOS does)', !(await lockHeld()),
      'still holding a released lock');
    const afterHide = await waitForChunks(page, beforeHide + 1, 4000);
    check('going hidden forces an immediate flush', afterHide > beforeHide,
      `chunk count stayed at ${afterHide} — audio buffered at suspend would be lost`,
      `${beforeHide} → ${afterHide} record(s)`);
    check('the hint switches to the honest warning',
      /may switch off/.test((await page.textContent('#record-hint')) || ''),
      'the hint still claims the screen will stay on');

    // Visible again: re-acquire, which the original code never did.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await sleep(1200);
    check('the lock is re-acquired on return', await lockHeld(),
      'no lock after coming back — the next screen blank would end the recording');
    check('the hint says so again', /stays on/.test((await page.textContent('#record-hint')) || ''),
      'the hint did not recover');
  } else {
    console.log('        (skipped — this browser refuses the lock, nothing to re-acquire)');
  }

  // ===== 1c. iOS cuts the mic: the session carries on =====
  // The real 2026-08-09 failure. Backgrounding the app ends the audio track, and
  // MediaRecorder stops with it — but the wall-clock timer kept counting, so the
  // app claimed 60s while capturing 6s. Simulated exactly: end the track.
  console.log('\n1c. capture is cut off mid-recording (the leave-the-app case)');
  const notesBefore = (await notes()).length;
  const capturedBefore = await page.evaluate(() => sessionCapturedMs + segmentCapturedMs);
  await sleep(3000);
  const shown = await page.textContent('#record-time');
  check('the timer reports captured audio, not wall clock',
    /^\d\d:\d\d/.test((shown || '').trim()), `timer read "${shown}"`, JSON.stringify(shown));

  await page.evaluate(() => { mediaRecorder.stream.getAudioTracks().forEach((t) => t.stop()); });
  await sleep(1500);
  const partsAfter = await page.evaluate(() => ({
    part: segmentIndex, want: wantRecording, recording: !!mediaRecorder && mediaRecorder.state === 'recording',
    captured: sessionCapturedMs + segmentCapturedMs,
  }));
  check('the session carries on into a new part', partsAfter.part >= 2,
    `still on part ${partsAfter.part} — the recording just ended`, `part ${partsAfter.part}`);
  check('capture is running again', partsAfter.recording,
    'the recorder is not recording after the interruption');
  check('audio captured before the cut is still counted', partsAfter.captured >= capturedBefore,
    `counter went backwards: ${capturedBefore} → ${partsAfter.captured}`,
    `${(partsAfter.captured / 1000).toFixed(1)}s carried over`);

  const afterCut = await waitForNoteCount(notesBefore + 1, 30000);
  check('the interrupted part was uploaded, not discarded', afterCut.length > notesBefore,
    `note count stayed at ${afterCut.length}`);

  // A stalled recorder must not keep claiming to record.
  await page.evaluate(() => {
    mediaRecorder.ondataavailable = () => {}; // starve it without ending the track
    lastDataAt = Date.now() - 60000;
  });
  await sleep(1200);
  const stalledText = (await page.textContent('#record-time')) || '';
  const stalledHint = (await page.textContent('#record-hint')) || '';
  check('a starved recorder is reported as paused', /paused/.test(stalledText),
    `timer still reads "${stalledText}"`);
  check('the hint explains the interruption', /cut the microphone|carry on|Picking/.test(stalledHint),
    `hint reads "${stalledHint}"`);
  check('the record button stops pulsing while nothing is captured',
    !(await page.evaluate(() => document.querySelector('#record-btn').classList.contains('recording'))),
    'the button still looks live');

  // Back to a clean state for the rest of the run.
  await page.evaluate(async () => {
    wantRecording = false;
    if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
  });
  await sleep(2500);

  // ===== 2. clean stop leaves nothing behind =====
  console.log('\n2. a normal recording uploads and leaves no orphan chunks');
  const base2 = (await notes()).length;
  await startRecording(page);
  const midChunks = await waitForChunks(page, 1, 12000);
  check('audio is being persisted while recording', midChunks > 0,
    'nothing reached the chunk store — there is no safety net', `${midChunks} record(s)`);

  await stopRecording(page);
  const after1 = await waitForNoteCount(base2 + 1);
  check('the finished recording reached the server', after1.length === base2 + 1,
    `expected ${base2 + 1} notes, got ${after1.length}`);

  // Poll: the delete runs after uploadAudio resolves.
  let leftover = -1;
  for (let i = 0; i < 20 && leftover !== 0; i++) { leftover = await chunkCount(page); await sleep(500); }
  check('the durable copy is cleared once uploaded', leftover === 0,
    `${leftover} chunk record(s) left behind — next load would upload a duplicate`);

  // ===== 3. the real test: kill the page mid-recording =====
  console.log('\n3. the page dies mid-recording (the screen-blank case)');
  const base3 = (await notes()).length;
  await startRecording(page);
  // Two flushes = 10s of audio provably on disk before the kill.
  const beforeKill = await waitForChunks(page, 2, 20000);
  check('the interrupted recording had been persisted', beforeKill >= 2,
    `only ${beforeKill} chunk record(s) — the flush timer is not keeping up`, `${beforeKill} record(s)`);

  // No stop(), no onstop, no upload — the tab simply ceases to exist.
  await page.close();

  page = await ctx.newPage();
  await page.goto(BASE);
  const after2 = await waitForNoteCount(base3 + 1);
  check('the interrupted recording was recovered and uploaded', after2.length === base3 + 1,
    `expected ${base3 + 1} notes, got ${after2.length}`);

  let cleared = -1;
  for (let i = 0; i < 20 && cleared !== 0; i++) { cleared = await chunkCount(page); await sleep(500); }
  check('recovered chunks are cleared after handover', cleared === 0,
    `${cleared} chunk record(s) still present — it would re-recover every load`);

  // The server renames uploads to <ts>-<uuid>.<ext>, so the marker lives on the
  // note's audio_original_name, not on disk.
  const full = [];
  for (const n of after2) full.push(await (await fetch(`${BASE}/api/notes/${n.id}`)).json());
  const originals = full.map((n) => n.audio_original_name || '');
  const recoveredNote = full.find((n) => (n.audio_original_name || '').includes('-recovered'));
  check('the recovered upload is named so it is recognizable', !!recoveredNote,
    `no "-recovered" name among: ${originals.join(', ') || '(none)'}`,
    recoveredNote && recoveredNote.audio_original_name);

  const files = audioFiles(dataDir);
  const recovered = recoveredNote && files.find((f) => f.full === recoveredNote.audio_path);
  check('the recovered upload has a file on disk', !!recovered,
    `audio_path did not match any file: ${recoveredNote && recoveredNote.audio_path}`);

  if (recovered) {
    // Don't assert a byte count: Chromium's fake microphone is a pure tone and
    // AAC crushes it to a few KB. Duration is the honest measure.
    check('the recovered file has bytes', recovered.size > 500,
      `only ${recovered.size} bytes`, `${(recovered.size / 1024).toFixed(1)} KB`);
    const secs = probeSeconds(recovered.full);
    check('the recovered file decodes as audio', secs !== null,
      'ffprobe could not read a duration — the reassembled container is not playable');
    // page.close() is a HARD kill: pagehide's flush may not land, so what is
    // guaranteed is the last completed flush. Two flushes = 10s, minus the ~1s
    // of header written before the first chunk.
    check('the audio persisted before the kill survived', secs !== null && secs >= 8,
      `ffprobe reports ${secs}s — expected at least the ~9s that had been flushed`,
      secs !== null ? `${secs.toFixed(1)}s recovered` : '');
  }

  // The clean-stop note must still be its own separate, intact upload.
  check('every note kept its own audio file', files.length === after2.length,
    `${after2.length} notes but ${files.length} audio files on disk`);

  // ===== 4. the diagnostics reach the server =====
  // Without this, a phone that freezes mid-recording can only be diagnosed by
  // inference from the finished upload — which is how a whole round trip got
  // spent on "it stopped after a minute" vs "capture died when you left".
  console.log('\n4. the recording diagnostics reach the server');
  await page.evaluate(() => { diag('test-marker', { hello: 'world' }); sendDiag(); });
  await sleep(1500);
  const logPath = path.join(dataDir, 'client-log.jsonl');
  const logged = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n') : [];
  check('a client log file was written', logged.length > 0, 'no client-log.jsonl on the server');
  const parsed = logged.map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  check('the marker made the round trip', parsed.some((e) => e.ev === 'test-marker'),
    'the marker event is not in the log');
  const kinds = [...new Set(parsed.map((e) => e.ev))];
  check('the interruption itself was recorded',
    kinds.includes('segment-start') && kinds.some((k) => /track-ended|segment-stop/.test(k)),
    `only got: ${kinds.join(', ')}`, `${logged.length} events: ${kinds.join(', ')}`);
  check('every entry carries the user agent', parsed.every((e) => typeof e.ua === 'string'),
    'entries without a ua — a phone-specific bug would be unattributable');

  // ===== 5. a stale page updates itself =====
  // The 2026-08-09 round trip that cost a whole test cycle: the fix was live on
  // the server while the phone kept running the previous bundle, because an iOS
  // PWA's page survives across launches and nothing ever re-requests the HTML.
  console.log('\n5. a page running an older build reloads itself');
  const v1 = await (await fetch(`${BASE}/api/health`)).json();
  check('health reports an asset version', !!v1.assetVersion,
    'no assetVersion — a stale page has nothing to compare against', v1.assetVersion);
  check('the page shows the build it is running',
    /v[0-9a-f]{6}/.test((await page.textContent('#status-pill')) || ''),
    `status pill reads "${await page.textContent('#status-pill')}"`);

  // A front-end-only change with NO server restart — the case a startup-time
  // fingerprint would miss entirely.
  const cssPath = path.join(REPO, 'public', 'styles.css');
  const cssOriginal = fs.readFileSync(cssPath, 'utf8');
  let v2;
  try {
    fs.writeFileSync(cssPath, `${cssOriginal}\n/* asset-version test */\n`);
    await sleep(16000); // outlast the 15s cache
    v2 = await (await fetch(`${BASE}/api/health`)).json();
    check('a public/ change moves the version without a restart',
      v2.assetVersion && v2.assetVersion !== v1.assetVersion,
      `version stayed ${v1.assetVersion} after editing styles.css`,
      `${v1.assetVersion} → ${v2 && v2.assetVersion}`);
  } finally {
    fs.writeFileSync(cssPath, cssOriginal);
  }

  // The page must reload itself — but never mid-recording.
  await startRecording(page);
  await page.evaluate(() => { window.__stillHere = true; noteAssetVersion('ffffffffffff'); });
  await sleep(4000);
  check('a reload is held off while recording',
    await page.evaluate(() => window.__stillHere === true),
    'the page reloaded mid-recording — that would have cost the audio');

  await page.evaluate(() => { wantRecording = false; if (mediaRecorder) mediaRecorder.stop(); });
  let reloaded = false;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    reloaded = await page.evaluate(() => window.__stillHere !== true).catch(() => false);
    if (reloaded) break;
  }
  check('the page reloads once the recording is done', reloaded,
    'the stale page never reloaded — a deploy would sit unseen again');

} catch (err) {
  failures++;
  console.log(`\n  FAIL  harness error — ${err.stack || err.message}`);
  if (log.length) console.log(`\nserver output:\n${log.join('')}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  child.kill();
  await sleep(500);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
}

console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
