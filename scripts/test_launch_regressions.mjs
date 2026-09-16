/**
 * Regressions from the pre-launch review (2026-09-15). Each failed against the
 * code as published at 4a4ed01:
 *
 *   1. /api/health sat behind the auth gate, so Docker's HEALTHCHECK (no token)
 *      reported the container unhealthy forever once AUTH_TOKEN was set.
 *   2. multer's own errors (wrong field name, over the size cap) were answered
 *      503 "retry", so a mis-built iOS Shortcut retried the same request forever.
 *   3. An upload was served back with the client's Content-Type: a text/html
 *      "recording" became a page on this origin, where the session cookie works.
 *   4. ?category=a&category=b (an array) threw inside SQLite and Express's
 *      default handler answered with an HTML stack trace naming server paths.
 *   5. A malformed JSON body got the same HTML page.
 *
 * Offline: temp DATA_DIR, no model keys.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const TOKEN = 'launch-token';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-launch-'));
Object.assign(process.env, {
  DATA_DIR: dir, AUTH_TOKEN: TOKEN, LLM_PROVIDER: 'openai', OPENAI_API_KEY: '', TRANSCRIBE_API_KEY: '',
});
const db = await import('../server/db.js');
const { api, errorHandler } = await import('../server/routes.js');

const app = express(); app.use(express.json()); app.use('/api', api); app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const headers = { authorization: `Bearer ${TOKEN}` };

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

function upload(field, filename, type, body) {
  const form = new FormData();
  form.append(field, new Blob([body], { type }), filename);
  return fetch(base + '/api/ingest', { method: 'POST', headers, body: form });
}

try {
  await check('/api/ping answers without a token; /api/health still needs one', async () => {
    const ping = await fetch(base + '/api/ping');
    assert.equal(ping.status, 200);
    assert.deepEqual(await ping.json(), { ok: true });
    assert.equal((await fetch(base + '/api/health')).status, 401);
    assert.equal((await fetch(base + '/api/health', { headers })).status, 200);
  });

  await check('an upload in the wrong field is a terminal 400, not a 503 retry', async () => {
    const res = await upload('file', 'memo.m4a', 'audio/mp4', 'xxxx');
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /audio/);
  });

  await check('a text/html "recording" is stored and served as an audio-or-octet type, never HTML', async () => {
    const res = await upload('audio', 'evil.html', 'text/html', '<script>alert(1)</script>');
    assert.equal(res.status, 201);
    const note = await res.json();
    assert.equal(note.audio_mime, 'application/octet-stream');
    assert.ok(!note.audio_path.endsWith('.html'), `kept the .html extension: ${note.audio_path}`);
    const audio = await fetch(`${base}/api/notes/${note.id}/audio`, { headers });
    assert.equal(audio.status, 200);
    assert.equal(audio.headers.get('content-type').split(';')[0], 'application/octet-stream');
    assert.equal(audio.headers.get('x-content-type-options'), 'nosniff');
    await fetch(`${base}/api/notes/${note.id}`, { method: 'DELETE', headers });
  });

  await check('an octet-stream upload named .m4a (an iOS Shortcut) is typed by its extension', async () => {
    const res = await upload('audio', 'memo.m4a', 'application/octet-stream', 'xxxx');
    assert.equal(res.status, 201);
    const note = await res.json();
    assert.equal(note.audio_mime, 'audio/mp4');
    assert.ok(note.audio_path.endsWith('.m4a'));
    await fetch(`${base}/api/notes/${note.id}`, { method: 'DELETE', headers });
  });

  await check('repeated query params are a 200, not an HTML 500', async () => {
    const res = await fetch(`${base}/api/notes?category=a&category=b&status=x&status=y`, { headers });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });

  await check('a malformed JSON body is a JSON 400 with no server paths', async () => {
    const res = await fetch(base + '/api/ingest', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{bad',
    });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('content-type').split(';')[0], 'application/json');
    const text = await res.text();
    assert.ok(!text.includes(path.sep + 'server' + path.sep), `leaked a path: ${text}`);
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
