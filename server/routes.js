import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { config, audioDir, uploadDir } from './config.js';
import {
  insertNote, getNote, updateNote, deleteNote, listNotes, searchNotes,
  listCategories, categoryTreeText, stats,
  listTasks, getTask, updateTask, taskStats, taskStates, usageSummary,
} from './db.js';
import { enqueue } from './jobs.js';
import { chat, chatAvailable } from './agents/chat.js';
import { transcriptionAvailable, longAudioSupported } from './transcribe.js';
import { categorizerAvailable } from './agents/categorizer.js';

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
      const ext = safeExt(file.originalname, file.mimetype);
      const name = `${Date.now()}-${crypto.randomUUID()}${ext}`;
      // Remembered so an upload the client abandons mid-body can be cleaned up:
      // multer never calls back in that case, so req.file is never set.
      (req.stagedUploads ||= []).push(path.join(uploadDir, name));
      cb(null, name);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB — long recordings are the whole point
});

// Non-blocking existsSync. The audio route is hit for every playback, and
// fs.existsSync stalls the event loop for the whole process on a slow or
// contended disk — cheap per call, but it is a request-path stall for everyone.
async function fileExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

// What we store and serve is always an audio type: the client's declared type
// and filename are hints, never trusted. Serving an upload back with a
// client-chosen Content-Type (text/html) would let anyone who can ingest plant
// a page on this origin, where the session cookie is valid.
const AUDIO_EXTS = new Set(['.m4a', '.mp4', '.mp3', '.mpga', '.mpeg', '.wav', '.webm', '.ogg', '.oga',
  '.opus', '.aac', '.flac', '.caf', '.aiff', '.aif', '.amr', '.3gp', '.wma']);
const MIME_BY_EXT = {
  '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac', '.mp3': 'audio/mpeg', '.mpga': 'audio/mpeg',
  '.mpeg': 'audio/mpeg', '.wav': 'audio/wav', '.webm': 'audio/webm', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.opus': 'audio/ogg', '.flac': 'audio/flac', '.caf': 'audio/x-caf', '.aiff': 'audio/aiff', '.aif': 'audio/aiff',
  '.amr': 'audio/amr', '.3gp': 'audio/3gpp', '.wma': 'audio/x-ms-wma',
};
export function safeAudioMime(mime = '', filename = '') {
  const m = String(mime).toLowerCase().split(';')[0].trim();
  if (/^(audio\/[\w.+-]+|video\/(mp4|webm|ogg|quicktime))$/.test(m)) return m;
  // iOS Shortcuts and curl send application/octet-stream; the extension is the better hint.
  return MIME_BY_EXT[path.extname(filename || '').toLowerCase()] || 'application/octet-stream';
}
function safeExt(originalName, mime) {
  const ext = path.extname(originalName || '').toLowerCase();
  return AUDIO_EXTS.has(ext) ? ext : guessExt(mime);
}

function guessExt(mime = '') {
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return '.m4a';
  if (mime.includes('mpeg') || mime.includes('mp3')) return '.mp3';
  if (mime.includes('webm')) return '.webm';
  if (mime.includes('wav')) return '.wav';
  if (mime.includes('ogg')) return '.ogg';
  return '.audio';
}

export const api = express.Router();

// Every error is answered as JSON. Express's default handler returns an HTML
// stack trace, which names absolute paths on this machine to whoever asked.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = Number(err.status || err.statusCode) || 500;
  if (status >= 500) console.error(`[http] ${req.method} ${req.originalUrl}:`, err.stack || err.message);
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
}

// Constant-time secret comparison: a plain === leaks how many leading characters
// matched. Different lengths return false without throwing.
export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// HttpOnly session cookies also authenticate native audio playback and uploads.
const sessionToken = crypto.randomBytes(32).toString('hex');
api.post('/session', (req, res) => {
  if (config.authToken && !safeEqual(req.body?.token, config.authToken)) {
    return res.status(401).json({ error: 'Incorrect access token' });
  }
  res.cookie('sb_session', sessionToken, {
    httpOnly: true, sameSite: 'strict', path: '/api',
    // A cookie with no lifetime dies when the browser (or a home-screen PWA)
    // closes, so the token would be asked for again every time the app reopens.
    // The server-side token already rotates on every restart, which bounds it.
    maxAge: 30 * 24 * 60 * 60 * 1000,
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
  });
  res.json({ ok: true });
});

// Liveness only, and deliberately above the auth gate: Docker's HEALTHCHECK and
// a service manager have no token, and a container whose health probe 401s is
// "unhealthy" forever. Everything informative stays on /api/health, behind auth.
api.get('/ping', (_req, res) => res.json({ ok: true }));

// Optional bearer-token auth for all API routes (set AUTH_TOKEN in .env).
api.use((req, res, next) => {
  if (!config.authToken) return next();
  const header = req.headers.authorization || '';
  if (safeEqual(header, `Bearer ${config.authToken}`)) return next();
  if ((req.headers.cookie || '').split(';').some((c) => safeEqual(c.trim(), `sb_session=${sessionToken}`))) return next();
  res.status(401).json({ error: 'Unauthorized' });
});

// ---- asset fingerprint: how a stale page finds out it is stale ----
// An iOS home-screen PWA keeps its page alive across launches, so a deploy can
// sit on the server for days while the phone happily runs the old bundle — the
// `?v=` cache-bust never helps, because nothing re-requests the HTML. Testing a
// fix against a phone still running the previous build reads exactly like the
// fix not working.
// The page compares this against the value it booted with and reloads itself.
//
// Computed per request, NOT once at startup: a front-end-only deploy needs no
// restart (express.static reads from disk per request), so a startup-time fingerprint would keep
// reporting the old build forever — the exact staleness this is meant to
// detect. Cached briefly and read asynchronously, because nothing sync belongs
// in a request path.
//
// It hashes `config.publicDir` — the same value the shell is served from — on
// purpose. A fingerprint resolved from a different path than the bytes it
// claims to describe is worse than no fingerprint at all.
const ASSET_FILES = ['index.html', 'app.js', 'styles.css', 'sw.js'];
const ASSET_TTL_MS = 15000;
let assetVersionCache = { value: null, at: 0 };

export async function assetVersion() {
  const now = Date.now();
  if (assetVersionCache.value && now - assetVersionCache.at < ASSET_TTL_MS) {
    return assetVersionCache.value;
  }
  const pub = config.publicDir;
  const h = crypto.createHash('sha256');
  for (const f of ASSET_FILES) {
    // Hash contents, not mtime: a sync tool touching a file must not look like a
    // deploy and bounce every open page.
    try { h.update(await fsp.readFile(path.join(pub, f))); } catch { h.update(`${f}:missing`); }
  }
  const value = h.digest('hex').slice(0, 12);
  assetVersionCache = { value, at: now };
  return value;
}

// ---- client-side recording diagnostics ----
// A phone that gets frozen mid-recording cannot report what happened, and the
// server otherwise only sees the finished upload — which is exactly why "it
// stopped after a minute" and "capture died the moment you left the app" were
// indistinguishable from here. The page posts its event trail; this
// appends it, capped, so it can be read without asking anyone to relay logs off
// a phone. Append is async: nothing sync belongs in a request path.
const CLIENT_LOG_MAX = 5 * 1024 * 1024;
api.post('/client-log', async (req, res) => {
  const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 500) : [];
  if (!events.length) return res.status(204).end();
  const file = path.join(config.dataDir, 'client-log.jsonl');
  try {
    const stat = await fsp.stat(file).catch(() => null);
    // Truncate rather than rotate: this is a debugging tail, not a record. Never
    // let it grow without bound on a box whose disk also holds the audio.
    if (stat && stat.size > CLIENT_LOG_MAX) await fsp.rm(file, { force: true });
    const ua = String(req.body?.ua || '').slice(0, 300);
    // `v` is the bundle the PAGE booted with; ASSET_VERSION is what the server
    // holds now. When they differ, the client was stale for these events.
    const v = String(req.body?.v || '').slice(0, 40);
    const serverV = await assetVersion();
    const lines = events
      .map((e) => JSON.stringify({
        received: new Date().toISOString(), ua, v, server_v: serverV, ...e,
      }))
      .join('\n');
    await fsp.appendFile(file, lines + '\n', 'utf8');
  } catch (err) {
    console.error('[client-log] could not append:', err.message);
  }
  res.status(204).end();
});

api.get('/health', async (_req, res) => {
  res.json({
    ok: true,
    assetVersion: await assetVersion(),
    ...stats(),
    tasks: taskStats(),
    transcription: transcriptionAvailable(),
    // Whisper caps uploads at 25MB, so anything longer than ~25 min needs ffmpeg
    // to split it. Reported from inside the server process on purpose: ffmpeg on
    // your shell's PATH proves nothing about the PATH a service manager gives it.
    // Awaited, never spawned synchronously: the probe resolves once per process
    // and this endpoint is what the watchdog kills the server over.
    longAudio: await longAudioSupported(),
    categorizer: categorizerAvailable(),
    chat: chatAvailable(),
    provider: config.llm.provider,
    models: { categorizer: config.llm.categorizerModel, chat: config.llm.chatModel },
  });
});

// ---- usage: what the model calls have cost ----
// Token counts are what each provider reported; costs are estimated at list
// price where the model has one. `total.unpriced_calls` says how many calls the
// dollar figure does NOT cover, so a partial total can't pass for a whole one.
api.get('/usage', (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 3650);
  res.json(usageSummary({ days }));
});

// ---- ingest: the single entry point for all capture paths ----
// multipart with an "audio" file (live recording, uploaded voice memo, iOS Shortcut)
// or JSON {"text": "..."} for pasted/pre-transcribed text.
// A multer/busboy failure (notably "Unexpected end of form" — the request body
// ended before the multipart terminator) used to fall through to Express's
// default handler: a bare 500 and a stack trace with no context. The context is
// the whole diagnosis.
//
// Note on measuring what arrived: req.socket.bytesRead looks like the obvious
// counter and is useless here — by the time this callback runs it has not moved
// since route entry, so it reads 0 even for a body that genuinely delivered
// bytes. Trusting it would misclassify a real truncated upload as empty and tell
// the client to throw the recording away. The declared Content-Length and the
// bytes multer actually wrote to disk are both reliable; use those.
function ingestUpload(req, res, next) {
  const lengthHeader = req.headers['content-length'];
  const declared = Number(lengthHeader || 0);
  // A client that drops the connection mid-body (phone loses signal, tab is
  // frozen) never gets multer's callback: busboy just stops, req.file is never
  // set, and the partial file sat in uploads/ forever. Every 30s outbox retry of
  // a long recording on a bad link wrote another one. The phone still holds the
  // complete recording and retries it, so the server's fragment is redundant.
  let multerDone = false;
  res.on('close', () => {
    if (multerDone || res.writableFinished || !req.stagedUploads?.length) return;
    // Give multer's write stream a moment to release the handle first.
    setTimeout(() => {
      for (const p of req.stagedUploads) fsp.rm(p, { force: true }).catch(() => {});
    }, 250).unref();
  });
  upload.single('audio')(req, res, async (err) => {
    multerDone = true;
    if (!err) return next();
    const written = req.file && typeof req.file.size === 'number' ? req.file.size : 0;
    console.error(
      `[ingest] upload failed: ${err.message} | declared=${declared}B written=${written}B` +
      ` | file=${req.file ? path.basename(req.file.path) : 'none'}` +
      ` | ip=${req.ip || '?'} | ua=${req.headers['user-agent'] || '?'}`
    );
    // A partial file is unplayable (no moov atom) and would otherwise sit in
    // audio/ looking like a real recording. Keep it out of the way, don't delete
    // it — a truncated capture is sometimes still worth trying to rebuild.
    if (req.file && req.file.path) {
      try {
        const quarantine = path.join(audioDir, '..', 'orphan-audio-quarantine');
        await fsp.mkdir(quarantine, { recursive: true });
        await fsp.rename(req.file.path, path.join(quarantine, path.basename(req.file.path)));
      } catch (moveErr) {
        console.error('[ingest] could not quarantine partial upload:', moveErr.message);
      }
    }
    // The status code decides whether the client keeps or discards its queued
    // copy, so it turns on one question: could this request have carried audio?
    //
    // An explicit "Content-Length: 0" says no. That is the evicted-blob case:
    // iOS kept the outbox record but lost the Blob's backing data, so FormData
    // serializes to an empty body. There is provably nothing to protect and
    // retrying cannot ever produce anything — the same empty body goes out
    // forever. 4xx is terminal for the client, so it clears the record and the
    // loop stops. This is also the only thing that can reach a stale page still
    // running the pre-fix code; a backgrounded iOS tab may not reload for days,
    // so the client-side guard alone would never fire.
    //
    // Matched on the header string, not the parsed number: a chunked body sends
    // no Content-Length at all, which parses to 0 and would be misread as empty.
    // multer's own errors (wrong field name, over the size limit, too many
    // parts) are about the request's shape, and the same request would fail
    // the same way forever. 4xx, so a mis-built iOS Shortcut stops retrying.
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: `Upload rejected: ${err.message} (send the file in a field named "audio")` });
    }
    if (lengthHeader === '0') {
      return res.status(400).json({
        error: 'Upload contained no audio (empty body) — the recording is no longer readable on this device, so it will not be retried.',
      });
    }
    // Otherwise bytes were intended and the connection dropped mid-transfer. The
    // queued copy may be the only complete one left, since what reached us is
    // truncated — so 5xx, keep it, retry. Capping attempts is the client's job.
    res.status(503).json({
      error: `Upload body ended early (${written}B of ${declared || 'unknown'}B written): ${err.message}`,
    });
  });
}

api.post('/ingest', ingestUpload, async (req, res) => {
  let note;
  if (req.file) {
    // A structurally valid multipart can still carry an empty file part — the
    // evicted-blob case reaches us this way when the client sends the boundary
    // correctly but has no bytes to put between them. Without this it became a
    // note that transcription could only fail on, so the failure showed up as a
    // broken note rather than a rejected upload. 4xx so the client stops retrying.
    if (req.file.size === 0) {
      await fsp.rm(req.file.path, { force: true }).catch(() => {});
      return res.status(400).json({
        error: 'Upload contained no audio (0 bytes) — nothing was recorded, so it will not be retried.',
      });
    }
    const finalPath = path.join(audioDir, path.basename(req.file.path));
    note = insertNote({
      source: req.body?.source === 'live' ? 'live' : 'upload',
      audioPath: finalPath,
      audioMime: safeAudioMime(req.file.mimetype, req.file.originalname),
      audioOriginalName: req.file.originalname || null,
    });
    // Reserve the final path in the DB before publishing the file to cleanup's directory.
    try {
      await fsp.rename(req.file.path, finalPath);
    } catch (err) {
      deleteNote(note.id);
      return res.status(500).json({ error: 'Could not store audio; please retry.' });
    }
  } else if (req.body && typeof req.body.text === 'string' && req.body.text.trim()) {
    note = insertNote({ source: 'text', transcript: req.body.text.trim() });
  } else {
    return res.status(400).json({ error: 'Send an "audio" file (multipart) or JSON {"text": "..."}' });
  }
  enqueue(note.id);
  res.status(201).json(note);
});

// ---- notes ----
// SQLite rejects a non-integer LIMIT/OFFSET ("datatype mismatch", a 500) and
// treats a negative LIMIT as "no limit", so both are clamped to whole numbers.
const intParam = (v, fallback, min, max) => Math.max(min, Math.min(Math.floor(Number(v)) || fallback, max));

api.get('/notes', (req, res) => {
  res.json(listNotes({
    category: String(req.query.category || '') || null,
    status: String(req.query.status || '') || null,
    limit: intParam(req.query.limit, 100, 1, 500),
    offset: intParam(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
  }));
});

api.get('/notes/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  res.json(searchNotes(q, {
    category: String(req.query.category || '') || null,
    limit: intParam(req.query.limit, 20, 1, 100),
    offset: intParam(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
  }));
});

api.get('/notes/:id', (req, res) => {
  const note = getNote(req.params.id);
  if (!note) return res.status(404).json({ error: 'Not found' });
  res.json(note);
});

api.get('/notes/:id/audio', async (req, res) => {
  const note = getNote(req.params.id);
  // 410, not 404: the recording existed and was intentionally pruned. The
  // transcript is still here — that distinction matters when you go looking.
  if (note && note.audio_pruned_at && !note.audio_path) {
    return res.status(410).json({
      error: `Audio was pruned on ${note.audio_pruned_at.slice(0, 10)} to save space. The transcript is kept.`,
    });
  }
  if (!note || !note.audio_path || !(await fileExists(note.audio_path))) {
    return res.status(404).json({ error: 'No audio for this note' });
  }
  // sendFile, not a bare createReadStream().pipe(): Safari will not play or seek
  // media from a server that ignores Range requests (it asks for bytes=0-1 and
  // expects a 206), and an unhandled read-stream error (file pruned between the
  // check and the read) would crash the whole process. dotfiles:'allow' because
  // DATA_DIR may legitimately live under a dot-folder.
  res.type(safeAudioMime(note.audio_mime, note.audio_path));
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Disposition', `inline; filename="note-${note.id}${path.extname(note.audio_path) || ''}"`);
  res.sendFile(path.resolve(note.audio_path), { dotfiles: 'allow' }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'No audio for this note' });
  });
});

// Re-run the pipeline (after fixing an API key, installing ffmpeg, etc.)
api.post('/notes/:id/process', (req, res) => {
  const note = getNote(req.params.id);
  if (!note) return res.status(404).json({ error: 'Not found' });
  updateNote(note.id, { status: 'captured', error: null });
  enqueue(note.id);
  res.json(getNote(note.id));
});

api.delete('/notes/:id', async (req, res) => {
  const note = getNote(req.params.id);
  if (!note) return res.status(404).json({ error: 'Not found' });
  // force:true makes a missing file a no-op, so this replaces the exists-then-
  // unlink pair — one async call instead of two sync ones, and no race between
  // the check and the delete.
  if (note.audio_path) await fsp.rm(note.audio_path, { force: true }).catch(() => {});
  deleteNote(note.id);
  res.json({ ok: true });
});

// ---- tasks ----
// Action items with state on them. `?category=Work` narrows to one category
// (and its children); `?tag=schedule` to one tag.
api.get('/tasks', (req, res) => {
  const states = String(req.query.state || 'open,working').split(',').map((s) => s.trim()).filter(Boolean);
  res.json({
    tasks: listTasks({
      states,
      category: req.query.category || null,
      tag: req.query.tag || null,
      limit: Math.min(Number(req.query.limit) || 200, 1000),
    }),
    stats: taskStats(),
  });
});

api.patch('/tasks/:id', express.json(), (req, res) => {
  if (!getTask(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const { state, note } = req.body || {};
  if (state !== undefined && !taskStates().includes(state)) {
    return res.status(400).json({ error: `state must be one of ${taskStates().join(', ')}` });
  }
  res.json(updateTask(req.params.id, { state, note }));
});

// ---- categories ----
api.get('/categories', (_req, res) => {
  res.json({ categories: listCategories(), tree: categoryTreeText() });
});

// ---- chat ----
api.post('/chat', express.json(), async (req, res) => {
  if (!chatAvailable()) {
    return res.status(503).json({ error: 'Chat needs a model provider. Set one in .env (see .env.example).' });
  }
  const history = Array.isArray(req.body?.messages) ? req.body.messages : null;
  if (!history || !history.length) {
    return res.status(400).json({ error: 'Send JSON {"messages": [{"role": "user", "content": "..."}]}' });
  }
  try {
    const reply = await chat(history);
    res.json({ reply });
  } catch (err) {
    console.error('[chat] error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});
