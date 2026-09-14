/**
 * Regressions from the second review pass (2026-09-14). Checks 2-6 failed
 * against the code as published at ddfc329:
 *
 *   1. An upload the client abandons mid-body must not leave a partial file in
 *      uploads/. multer 2 already cleans it up; multer 1.x never called back, so
 *      this guards against a downgrade.
 *   2. A crash between reserving a note's audio path and moving the staged file
 *      left the note pointing at nothing while the recording sat in uploads/.
 *   3. Nothing ever removed abandoned staging files.
 *   4. Audio ignored Range requests (Safari won't play or seek without a 206).
 *   5. /api/notes?limit=1.5 was a 500 (SQLite "datatype mismatch").
 *   6. Load more rendered a note twice when one arrived between pages.
 *
 * Offline: temp DATA_DIR, no model keys.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import vm from 'node:vm';
import express from 'express';

const TOKEN = 'second-pass-token';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-second-pass-'));
Object.assign(process.env, {
  DATA_DIR: dir, AUTH_TOKEN: TOKEN, LLM_PROVIDER: 'openai', OPENAI_API_KEY: '', TRANSCRIBE_API_KEY: '',
});
const db = await import('../server/db.js');
const { api } = await import('../server/routes.js');
const jobs = await import('../server/jobs.js');
const { audioDir, uploadDir } = await import('../server/config.js');

const app = express(); app.use(express.json()); app.use('/api', api);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const headers = { authorization: `Bearer ${TOKEN}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL ${name}\n     ${String(err.message).split('\n').slice(0, 4).join('\n     ')}`);
  }
}

function runNode(args, env, timeoutMs = 90000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    const t = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

try {
  await check('abandoned upload leaves no staging file', async () => {
    await new Promise((resolve) => {
      const b = 'abandon';
      const req = http.request(base + '/api/ingest', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': `multipart/form-data; boundary=${b}`, 'Content-Length': '200000' },
      }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', () => resolve());
      req.write(`--${b}\r\nContent-Disposition: form-data; name="audio"; filename="r.m4a"\r\nContent-Type: audio/mp4\r\n\r\n${'x'.repeat(8000)}`);
      setTimeout(() => req.destroy(), 300);
    });
    let left = [];
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      left = await fs.readdir(uploadDir);
      if (!left.length) break;
    }
    assert.deepEqual(left, [], 'an abandoned upload must not leave its partial file in uploads/');
  });

  await check('startup finishes a reserved upload move', async () => {
    const name = `${Date.now()}-reserved.m4a`;
    const reserved = db.insertNote({ source: 'live', audioPath: path.join(audioDir, name), audioMime: 'audio/mp4' });
    try {
      await fs.writeFile(path.join(uploadDir, name), 'complete recording');
      assert.equal(typeof jobs.recoverReservedUploads, 'function', 'no recovery for reserved uploads');
      assert.equal(await jobs.recoverReservedUploads(), 1);
      assert.equal(await fs.readFile(reserved.audio_path, 'utf8'), 'complete recording');
      await assert.rejects(fs.access(path.join(uploadDir, name)));
    } finally {
      db.deleteNote(reserved.id);
      await fs.rm(reserved.audio_path, { force: true });
      await fs.rm(path.join(uploadDir, name), { force: true });
    }
  });

  await check('pruner removes only stale, unclaimed staging files', async () => {
    const stale = path.join(uploadDir, 'stale-partial.m4a');
    const fresh = path.join(uploadDir, 'fresh-partial.m4a');
    const claimedName = 'claimed-partial.m4a';
    const claimed = path.join(uploadDir, claimedName);
    const claimNote = db.insertNote({ source: 'live', audioPath: path.join(audioDir, claimedName), audioMime: 'audio/mp4' });
    try {
      for (const f of [stale, fresh, claimed]) await fs.writeFile(f, 'partial');
      const old = new Date(Date.now() - 3 * 86400000);
      await fs.utimes(stale, old, old);
      await fs.utimes(claimed, old, old);
      const prune = await runNode(['scripts/prune_audio.mjs'], { LOCALAPPDATA: dir });
      assert.equal(prune.code, 0, prune.out);
      const staged = (await fs.readdir(uploadDir)).filter((f) => f.endsWith('-partial.m4a')).sort();
      assert.deepEqual(staged, ['claimed-partial.m4a', 'fresh-partial.m4a'], prune.out);
    } finally {
      for (const f of [stale, fresh, claimed]) await fs.rm(f, { force: true });
      db.deleteNote(claimNote.id);
    }
  });

  await check('audio honors Range and survives a missing file', async () => {
    const dotDir = path.join(dir, '.hidden-audio');
    await fs.mkdir(dotDir, { recursive: true });
    const audioFile = path.join(dotDir, 'a.m4a');
    await fs.writeFile(audioFile, Buffer.alloc(1000, 7));
    const audioNote = db.insertNote({ source: 'upload', audioPath: audioFile, audioMime: 'audio/mp4' });
    try {
      const ranged = await fetch(`${base}/api/notes/${audioNote.id}/audio`, { headers: { ...headers, Range: 'bytes=0-1' } });
      assert.equal(ranged.status, 206);
      assert.equal(ranged.headers.get('content-range'), 'bytes 0-1/1000');
      assert.equal(ranged.headers.get('content-type'), 'audio/mp4');
      assert.equal((await ranged.arrayBuffer()).byteLength, 2);
      const whole = await fetch(`${base}/api/notes/${audioNote.id}/audio`, { headers });
      assert.equal(whole.status, 200);
      assert.equal((await whole.arrayBuffer()).byteLength, 1000);
      await fs.rm(audioFile);
      assert.equal((await fetch(`${base}/api/notes/${audioNote.id}/audio`, { headers })).status, 404);
    } finally {
      db.deleteNote(audioNote.id);
    }
  });

  // Enough notes for two pages.
  for (let i = 0; i < 120; i++) db.insertNote({ source: 'text', transcript: `note ${i}` });

  await check('paging params are clamped to whole numbers', async () => {
    for (const qs of ['limit=1.5', 'offset=2.5', 'limit=-1', 'offset=-3', 'limit=abc']) {
      const r = await fetch(`${base}/api/notes?${qs}`, { headers });
      assert.equal(r.status, 200, qs);
      assert.ok((await r.json()).length >= 1, qs);
    }
  });

  await check('Load more never renders a note twice', async () => {
    const source = await fs.readFile('public/app.js', 'utf8');
    const elements = {
      '#notes-more': { addEventListener() {}, disabled: false, hidden: true },
      '#search-input': { value: '' }, '#category-filter': { value: '' },
      '#notes-list': { innerHTML: '', insertAdjacentHTML(_p, html) { this.innerHTML += html; } },
    };
    const paging = {
      $: (k) => elements[k], $$: () => [], URLSearchParams, Set,
      loadCategories() {}, noteCard: (n) => `<article>${n.id}</article>`,
      apiFetch: (url) => fetch(base + url, { headers }),
    };
    vm.createContext(paging);
    vm.runInContext(source.slice(source.indexOf('let notesOffset ='), source.indexOf('function statusTag')), paging);
    await paging.refreshNotes();
    await sleep(5); // a distinct created_at, so the newcomer sorts first
    const newcomer = db.insertNote({ source: 'text', transcript: 'arrived between pages' });
    await paging.refreshNotes(true);
    db.deleteNote(newcomer.id);
    const ids = elements['#notes-list'].innerHTML.match(/<article>[^<]+<\/article>/g);
    assert.equal(new Set(ids).size, ids.length, 'Load more rendered a note twice');
    assert.equal(ids.length, 120);
  });

  if (failures.length) {
    console.log(`\n${failures.length} FAILED, ${passed} passed`);
    process.exitCode = 1;
  } else {
    console.log(`\nALL PASS (${passed} checks)`);
  }
} finally {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  db.closeDb();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}
