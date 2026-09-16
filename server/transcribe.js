import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { withRetry, terminal } from './retry.js';
import { recordUsage } from './db.js';

// Whisper's API caps uploads at 25 MB. Longer recordings (full presentations,
// hour-long voice memos) get split into segments with ffmpeg when available.
const WHISPER_MAX_BYTES = 24 * 1024 * 1024;
const SEGMENT_SECONDS = 600; // 10-minute chunks

export function transcriptionAvailable() {
  return Boolean(config.transcribe.apiKey);
}

// Exported so /api/health can answer "can this box handle a long recording?"
// before someone uploads an hour-long call and waits for it to fail. ffmpeg being
// on *your* PATH is not the question: it has to be on the PATH of the server
// process, which a service manager may launch with a different one.
//
// Async and memoised. Returns a promise — /api/health awaits it. The probe runs
// at most once per process; every later call resolves from the cached promise
// without touching the event loop.
//
// Nothing here may use spawnSync. /api/health is what a health check or
// watchdog probes, so anything that can stall this endpoint is a liveness check
// capable of killing the healthy server it is meant to protect.
let ffmpegProbe = null;
export function longAudioSupported() {
  if (!ffmpegProbe) ffmpegProbe = runFfmpeg(['-version']).then((code) => code === 0);
  return ffmpegProbe;
}

// Resolves with the exit code; -1 when ffmpeg isn't on PATH at all (spawn emits
// 'error' rather than exiting, and without this handler that error is unhandled).
function runFfmpeg(args) {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', args, { stdio: 'ignore' });
    child.once('error', () => resolve(-1));
    child.once('close', (code) => resolve(code === null ? -1 : code));
  });
}

// Asks for verbose_json because it carries the audio's duration, which is what
// transcription is billed on. A server that answers with plain text instead
// (some local Whisper servers do) still works; that segment is logged as
// unmeasured rather than guessed.
async function whisperFile(filePath, mime, noteId) {
  // Async read: this is up to 24MB, and it runs once per segment, so a
  // synchronous read stalls the server repeatedly through a long transcription.
  const buf = await fsp.readFile(filePath);
  const name = path.basename(filePath);

  // Retried per-segment: a 10-minute chunk that 429s shouldn't cost the whole
  // hour-long recording. The form is rebuilt each attempt — a consumed body
  // can't be re-sent.
  const { text, seconds } = await withRetry(`transcribe ${name}`, async () => {
    const form = new FormData();
    form.append('file', new Blob([buf], { type: mime || 'application/octet-stream' }), name);
    form.append('model', config.transcribe.model);
    form.append('response_format', 'verbose_json');

    const res = await fetch(`${config.transcribe.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.transcribe.apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`Transcription failed (${res.status}): ${body.slice(0, 500)}`);
      err.status = res.status; // lets withRetry tell a 429/503 from a 400 bad-audio reject
      throw err;
    }
    const raw = await res.text();
    try {
      const data = JSON.parse(raw);
      if (data && typeof data.text === 'string') {
        return { text: data.text.trim(), seconds: typeof data.duration === 'number' ? data.duration : null };
      }
    } catch { /* not JSON: a plain-text answer */ }
    return { text: raw.trim(), seconds: null };
  });

  const price = config.transcribe.pricePerMinute;
  try {
    recordUsage({
      purpose: 'transcribe',
      provider: 'transcription',
      model: config.transcribe.model,
      note_id: noteId,
      audio_seconds: seconds,
      cost_usd: seconds == null || price == null ? null : (seconds / 60) * price,
      cost_basis: seconds == null ? 'unmeasured' : price == null ? 'unpriced' : 'estimated',
    });
  } catch (err) {
    console.error('[usage] could not record:', err.message);
  }
  return text;
}

export async function transcribeAudio(filePath, mime, noteId = null) {
  if (!transcriptionAvailable()) {
    throw terminal(new Error('No transcription key is set (OPENAI_API_KEY or TRANSCRIBE_API_KEY). Add one to .env and retry processing.'));
  }
  const { size } = await fsp.stat(filePath);
  if (size <= WHISPER_MAX_BYTES) {
    return whisperFile(filePath, mime, noteId);
  }

  if (!(await longAudioSupported())) {
    throw terminal(new Error(
      `Audio file is ${(size / 1024 / 1024).toFixed(1)} MB, above the 25 MB transcription limit, ` +
      'and ffmpeg is not installed to split it. Install ffmpeg and retry processing.'
    ));
  }

  // Split into segments, transcribe each in order, join.
  //
  // The split is the longest single operation in the app: measured at 19.4s for
  // 20 minutes of audio, so roughly 70s for a 72-minute call (it re-encodes, so
  // cost scales with duration). Run synchronously it froze the whole server for
  // that entire stretch — long past the ~30s the watchdog waits before killing
  // the process, which would have destroyed the very job it was running.
  // Spawned async, ffmpeg works in its own process and the event loop stays free.
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-seg-'));
  try {
    const pattern = path.join(tmpDir, 'seg-%04d.m4a');
    const code = await runFfmpeg([
      '-i', filePath,
      '-f', 'segment',
      '-segment_time', String(SEGMENT_SECONDS),
      '-c:a', 'aac', '-b:a', '64k', '-vn',
      pattern,
    ]);
    if (code !== 0) throw terminal(new Error('ffmpeg failed to split the audio file.'));

    const entries = await fsp.readdir(tmpDir);
    // Zero-padded by the %04d pattern, so lexical order IS recording order —
    // seg-0010 sorts after seg-0009. Covered by test_transcribe_chunking.mjs,
    // which deliberately produces more than nine segments.
    const segments = entries.filter((f) => f.startsWith('seg-')).sort();
    if (!segments.length) throw terminal(new Error('ffmpeg produced no audio segments.'));

    const parts = [];
    for (const seg of segments) {
      parts.push(await whisperFile(path.join(tmpDir, seg), 'audio/mp4', noteId));
    }
    return parts.join('\n\n').trim();
  } finally {
    // Up to ~70MB of segments; deleting it synchronously stalls the server too.
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
