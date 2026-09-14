/* Second Brain frontend */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// Cookie authentication covers fetch, XHR uploads, and the native audio player.
async function apiFetch(url, options) {
  const res = await fetch(url, options);
  if (res.status === 401) $('#auth-form').hidden = false;
  return res;
}
$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const res = await apiFetch('/api/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: $('#auth-token').value }),
  });
  if (!res.ok) { $('#auth-message').textContent = 'Incorrect access token'; return; }
  $('#auth-token').value = '';
  $('#auth-message').textContent = '';
  $('#auth-form').hidden = true;
  refreshHealth(); loadCategories(); refreshNotes(); refreshTasks(); flushOutbox();
});

// ---------- tabs ----------
$$('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${btn.dataset.tab}`));
    if (btn.dataset.tab === 'notes') refreshNotes();
    if (btn.dataset.tab === 'tasks') refreshTasks();
  });
});

// ---------- self-update ----------
// An iOS home-screen PWA keeps its page alive across launches. A deploy can
// therefore sit on the server for days while the phone runs the old bundle, and
// the `?v=` cache-bust cannot help — nothing re-requests the HTML. Testing a fix
// against a phone still running the previous build is indistinguishable from
// the fix not working. The server's asset fingerprint is the only thing
// that can reach a stale page, so the page reloads itself when it changes.
let bootAssetVersion = null;
let selfUpdatePending = false;
let uploadsInFlight = 0;

function noteAssetVersion(version) {
  if (!version) return;
  if (!bootAssetVersion) { bootAssetVersion = version; return; }
  if (version === bootAssetVersion || selfUpdatePending) return;
  selfUpdatePending = true;
  diag('app-update', { from: bootAssetVersion, to: version });
  sendDiag();
  const tryReload = () => {
    // Never yank the page out from under a recording or an upload in flight —
    // that would trade a stale bundle for lost audio.
    if (wantRecording || outboxFlushing || uploadsInFlight > 0) {
      setTimeout(tryReload, 3000);
      return;
    }
    location.reload();
  };
  setTimeout(tryReload, 500);
}

// ---------- health pill ----------
async function refreshHealth() {
  try {
    const res = await apiFetch('/api/health', { cache: 'no-store' });
    if (!res.ok) { $('#status-pill').textContent = res.status === 401 ? 'locked' : 'unavailable'; return; }
    const h = await res.json();
    noteAssetVersion(h.assetVersion);
    const bits = [];
    bits.push(`${h.total_notes} notes`);
    if (!h.transcription) bits.push('no transcription key');
    if (!h.categorizer) bits.push('no model set');
    // The build this page is actually running. Cheap, and it ends the "is the
    // phone on the new code?" question that cost a whole test round trip.
    if (bootAssetVersion) bits.push(`v${bootAssetVersion.slice(0, 6)}`);
    $('#status-pill').textContent = bits.join(' · ');
  } catch {
    $('#status-pill').textContent = 'offline';
  }
}
refreshHealth();
// Coming back to the app is exactly when a stale page needs to find out, and on
// an iOS PWA it is the most reliable moment anything runs at all.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshHealth();
});
setInterval(refreshHealth, 5 * 60 * 1000);

// ---------- live recording ----------
// A recording is a SESSION made of one or more SEGMENTS. iOS interrupts audio
// capture when the app stops being frontmost, and there is no way to talk the
// platform out of it reliably — so the session survives the interruption by
// starting a new segment when we get the foreground back, and every segment is
// uploaded, so nothing is lost. See docs/RELIABILITY.md.
let mediaRecorder = null;
let chunks = [];
let timerInterval = null;
let startedAt = 0;          // wall clock, this segment
let segmentCapturedMs = 0;  // audio ACTUALLY captured, this segment
let sessionCapturedMs = 0;  // audio actually captured in earlier segments
let lastDataAt = 0;         // when the recorder last handed us audio
let wantRecording = false;  // the user's intent — true until they tap stop
let segmentIndex = 0;
let sessionId = '';
let resuming = false;
let userStopped = false;
let lastResumeAt = 0;

// If the recorder hands us nothing for this long, capture is dead — it does not
// go quiet on its own, it delivers a blob every timeslice even during silence.
const STALL_MS = 4000;

const recordBtn = $('#record-btn');
const recordTime = $('#record-time');
const recordHint = $('#record-hint');

function pickMime() {
  const candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

function extFor(type) {
  return type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
}

// ---------- screen wake lock ----------
// A phone that blanks its screen suspends the tab, and a suspended tab's
// MediaRecorder stops delivering data — the recording just ends, silently, with
// whatever was in memory. Holding a screen wake lock for the duration of a
// recording is the fix, with two caveats that shape the code below:
//   * iOS RELEASES the lock every time the page hides, so acquiring it once is
//     not enough — it has to be re-requested on visibilitychange.
//   * The request is REFUSED outright in Low Power Mode (and unsupported on
//     older iOS), so it can never be the only defense. See the chunk store.
let wakeLock = null;

async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return false;
  if (wakeLock) return true;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    // Fires on OS-initiated release (page hidden, Low Power Mode kicking in).
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
      if (isRecording()) setRecordHint();
    });
    return true;
  } catch {
    wakeLock = null;
    return false;
  }
}

function releaseWakeLock() {
  const held = wakeLock;
  wakeLock = null;
  if (held) held.release().catch(() => {});
}

// ---------- keeping the audio session alive ----------
// Best-effort attempts to stop iOS interrupting capture the moment the app is
// backgrounded. Neither is guaranteed — which is why the segment/resume machinery
// below exists and does not depend on either working.
let audioCtx = null;

// Safari 17+. Tells WebKit this page is a recorder, so it picks the AVAudioSession
// play-and-record category rather than a plain playback one.
function primeAudioSession() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'play-and-record';
  } catch { /* not supported — nothing lost */ }
}

// An AudioContext with the mic wired through a silent gain keeps a live audio
// graph, which is what iOS looks at when deciding whether a backgrounded page
// still needs its audio session.
function startKeepAlive(stream) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const src = audioCtx.createMediaStreamSource(stream);
    const gain = audioCtx.createGain();
    gain.gain.value = 0; // never actually plays anything
    src.connect(gain);
    gain.connect(audioCtx.destination);
  } catch { /* keep-alive is a bonus, never a requirement */ }
}

// ---------- is capture actually running? ----------
// The recorder emits a blob every timeslice even through silence, so "no data for
// a few seconds" means capture is dead, not that the room went quiet. This is the
// difference between the app knowing it stopped and the app claiming minutes of
// audio that do not exist.
function captureStalled() {
  return wantRecording && lastDataAt > 0 && (Date.now() - lastDataAt) > STALL_MS;
}

function fmt(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// The timer shows CAPTURED audio, never wall clock. Showing wall clock is what
// turned "iOS cut the mic when you switched apps" into "the app said it recorded
// 60 seconds and produced 6" — the user had no way to know until they played it
// back. (Measured 2026-08-09: a 5-minute foreground note captured 315s of 319s
// wall clock; two backgrounded ones captured 6s of 60s and 19s of 66s.)
function renderRecordTime() {
  if (!wantRecording) return;
  const total = sessionCapturedMs + segmentCapturedMs;
  // Stop the button pulsing while nothing is being captured — a live-looking
  // record button is the same lie as a running timer.
  recordBtn.classList.toggle('recording', isRecording() && !captureStalled());
  if (captureStalled()) {
    recordTime.textContent = `${fmt(total)} recorded — paused`;
  } else {
    recordTime.textContent = `${fmt(total)}${segmentIndex > 1 ? ` (part ${segmentIndex})` : ''} — tap to stop`;
  }
}

// Says what is actually true. A silently refused wake lock, or capture that has
// been cut off, reads exactly like the original defect if nothing says so.
function setRecordHint() {
  if (!recordHint) return;
  if (!wantRecording) { recordHint.textContent = ''; recordHint.hidden = true; return; }
  recordHint.hidden = false;
  if (captureStalled() || !isRecording()) {
    recordHint.textContent = resuming
      ? 'Picking the recording back up…'
      : 'iOS cut the microphone off while the app was in the background. Everything up to that point is saved — tap to carry on.';
    return;
  }
  if (wakeLock) {
    recordHint.textContent = chunkPersistFailed
      ? 'Screen will stay on. Keep the app open — audio is not being backed up on this device.'
      : 'Screen stays on. Leaving the app stops the mic — it picks back up when you return.';
  } else {
    recordHint.textContent = chunkPersistFailed
      ? "Screen may switch off (Low Power Mode?) and audio is not being backed up — keep the screen on."
      : "Screen may switch off (Low Power Mode?) — audio is saved every few seconds, so anything captured is kept.";
  }
}

document.addEventListener('visibilitychange', () => {
  if (!wantRecording) return;
  if (document.visibilityState === 'visible') {
    diag('visible', { stalled: captureStalled(), state: mediaRecorder && mediaRecorder.state });
    acquireWakeLock().then(setRecordHint);
    // The whole point: we are back, so put the microphone back on. If capture
    // survived (a short hide, or a platform that allows it), this does nothing.
    maybeResume();
    sendDiag();
  } else {
    diag('hidden');
    // Last gasp before the OS suspends us: force the recorder to hand over
    // everything it is holding, then persist it.
    flushRecordingToDisk();
  }
});
window.addEventListener('pagehide', () => { diag('pagehide'); flushRecordingToDisk(); sendDiag(true); });
window.addEventListener('freeze', () => { diag('freeze'); flushRecordingToDisk(); sendDiag(true); });
window.addEventListener('resume', () => { diag('resume'); maybeResume(); });

recordBtn.addEventListener('click', () => {
  if (isRecording() && !captureStalled()) {
    userStopped = true;
    wantRecording = false;
    diag('user-stop');
    mediaRecorder.stop();
    return;
  }
  // Interrupted mid-session: the button carries on rather than starting over.
  if (wantRecording) { maybeResume(true); return; }
  startSession();
});

async function startSession() {
  wantRecording = true;
  userStopped = false;
  segmentIndex = 0;
  sessionCapturedMs = 0;
  sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  diag('session-start', { ua: navigator.userAgent, standalone: !!window.navigator.standalone });
  const started = await startSegment();
  if (!started) { wantRecording = false; setRecordHint(); }
}

// Returns true if capture is running. Each segment is its own MediaRecorder, its
// own file and its own note — a session that iOS interrupts four times arrives as
// four parts rather than as one truncated recording.
async function startSegment() {
  try {
    primeAudioSession();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    startKeepAlive(stream);
    const mime = pickMime();
    mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    chunks = [];
    segmentIndex += 1;
    segmentCapturedMs = 0;
    lastDataAt = 0;
    startedAt = Date.now();
    const type = mediaRecorder.mimeType || mime || 'audio/webm';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // Part number only once there IS more than one part, so an ordinary
    // recording's filename is unchanged.
    const filename = segmentIndex > 1
      ? `recording-${stamp}-part${segmentIndex}.${extFor(type)}`
      : `recording-${stamp}.${extFor(type)}`;
    const session = startChunkSession(type, filename);

    const track = stream.getAudioTracks()[0];
    if (track) {
      // iOS may end the track outright or merely mute it; a muted track records
      // silence, which is just as much a lost recording. Treat both as capture lost.
      track.addEventListener('ended', () => { diag('track-ended'); onCaptureLost(); });
      track.addEventListener('mute', () => { diag('track-muted'); onCaptureLost(); });
      track.addEventListener('unmute', () => { diag('track-unmuted'); maybeResume(); });
    }

    mediaRecorder.onerror = (e) => { diag('recorder-error', { msg: String(e && e.error && e.error.name) }); onCaptureLost(); };
    mediaRecorder.ondataavailable = (e) => {
      if (!e.data.size) return;
      const now = Date.now();
      if (!lastDataAt) {
        segmentCapturedMs += now - startedAt;
      } else {
        const delta = now - lastDataAt;
        // A gap is time during which nothing was captured — counting it would put
        // the lie back into the timer.
        if (delta <= STALL_MS) segmentCapturedMs += delta;
        else diag('data-gap', { ms: delta });
      }
      lastDataAt = now;
      chunks.push(e.data);
      bufferChunk(e.data);
    };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      // Snapshot before the await: the next segment reassigns these immediately.
      const blob = new Blob(chunks, { type });
      const capturedMs = segmentCapturedMs;
      const part = segmentIndex;
      // THE signal that capture was taken away. Do not hang this off the track's
      // `ended`/`mute` events alone — `stop()` fires neither, and which one iOS
      // delivers varies. A recorder that stopped while the user still wants to be
      // recording was interrupted, whatever the cause.
      const involuntary = wantRecording && !userStopped;
      diag('segment-stop', { part, capturedMs, bytes: blob.size, involuntary });
      if (involuntary) {
        sessionCapturedMs += capturedMs;
        segmentCapturedMs = 0;
        setRecordHint();
        // Deliberately NOT awaited: the upload can take 30s on cellular, and
        // every one of those seconds would be audio the microphone was not on for.
        maybeResume();
      }
      if (!wantRecording) {
        clearInterval(timerInterval);
        stopChunkFlushTimer();
        releaseWakeLock();
        recordBtn.classList.remove('recording');
        recordTime.textContent = 'uploading…';
        setRecordHint();
      }
      const label = part > 1 ? `part ${part} (${fmt(capturedMs)})` : filename;
      if (blob.size > 0) await uploadAudio(blob, filename, 'live');
      else feedItem('').innerHTML = `${ic('alert')}${esc(label)} captured no audio — nothing to upload`;
      // Only now is the durable copy redundant: uploadAudio has either got a note
      // id back, parked the blob in the outbox, or hit a terminal reject. Deleting
      // it any earlier would leave the upload itself unprotected.
      await discardChunkSession(session);
      if (!wantRecording) { recordTime.textContent = 'tap to record'; sendDiag(); }
    };

    mediaRecorder.start(1000); // a blob every second, so a kill costs one second
    recordBtn.classList.add('recording');
    startChunkFlushTimer();
    await acquireWakeLock();
    setRecordHint();
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      renderRecordTime();
      setRecordHint();
      // The other shape of the failure: the recorder never stops, it just goes
      // quiet (a muted track, a frozen page). onstop never fires, so the stall is
      // the only signal there is.
      if (captureStalled() && document.visibilityState === 'visible') maybeResume();
    }, 500);
    renderRecordTime();
    diag('segment-start', { part: segmentIndex, mime: type });
    return true;
  } catch (err) {
    diag('segment-start-failed', { msg: err && err.message });
    recordBtn.classList.remove('recording');
    recordTime.textContent = 'tap to record';
    if (segmentIndex === 0) alert(`Microphone unavailable: ${err.message}`);
    return false;
  }
}

// Capture died without the user asking. Close the segment so its audio is
// uploaded, then try to carry on — which only succeeds once we have the
// foreground back, so a hidden page just waits for visibilitychange.
function onCaptureLost() {
  if (!wantRecording) return;
  sessionCapturedMs += segmentCapturedMs;
  segmentCapturedMs = 0;
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    try { mediaRecorder.stop(); } catch { /* already gone */ }
  }
  setRecordHint();
  if (document.visibilityState === 'visible') maybeResume();
}

async function maybeResume(fromTap = false) {
  if (!wantRecording || resuming) return;
  if (isRecording() && !captureStalled()) return;      // capture survived
  if (document.visibilityState !== 'visible' && !fromTap) return; // no mic in the background
  // The stall check fires twice a second; without a cooldown a permanently
  // refused microphone would be retried 120 times a minute.
  if (!fromTap && Date.now() - lastResumeAt < 3000) return;
  lastResumeAt = Date.now();
  resuming = true;
  setRecordHint();
  try {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      sessionCapturedMs += segmentCapturedMs;
      segmentCapturedMs = 0;
      try { mediaRecorder.stop(); } catch { /* already gone */ }
    }
    diag('resume-attempt', { nextPart: segmentIndex + 1 });
    const started = await startSegment();
    diag('resume-result', { started });
    if (!started) {
      // Safari can refuse getUserMedia without a fresh gesture. Say so and let
      // the button be the gesture, rather than silently ending the session.
      recordTime.textContent = `${fmt(sessionCapturedMs)} recorded — tap to carry on`;
    }
  } finally {
    resuming = false;
    setRecordHint();
  }
}

// ---------- recording diagnostics ----------
// A phone that freezes mid-recording cannot tell anyone what happened, and the
// server only ever sees the finished upload — which is how "it stopped after a
// minute" and "capture died the moment you left the app" looked identical from
// here. The trail is posted to the server so it can be read without anyone
// having to relay logs off the phone.
const diagEvents = [];
function diag(ev, detail) {
  diagEvents.push({ t: new Date().toISOString(), ev, session: sessionId, ...(detail || {}) });
  if (diagEvents.length > 300) diagEvents.splice(0, diagEvents.length - 300);
}

function sendDiag(beacon = false) {
  if (!diagEvents.length) return;
  // The build tag rides along, so a log line can never be misread as coming from
  // code the phone was not actually running.
  const body = JSON.stringify({
    ua: navigator.userAgent,
    v: bootAssetVersion,
    events: diagEvents.splice(0, diagEvents.length),
  });
  try {
    if (beacon && navigator.sendBeacon) {
      navigator.sendBeacon('/api/client-log', new Blob([body], { type: 'application/json' }));
    } else {
      apiFetch('/api/client-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true })
        .catch(() => {});
    }
  } catch { /* diagnostics must never break a recording */ }
}

function mb(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function isRecording() {
  return !!mediaRecorder && mediaRecorder.state === 'recording';
}

// The record line belongs to the recorder. A background upload must never
// overwrite a live recording timer — you can record while an upload is in flight.
function setRecordStatus(text) {
  if (isRecording()) return;
  recordTime.textContent = text;
}

// XHR (not fetch) so we get upload.onprogress — a big recording over cellular
// is a silent 30-90s wait otherwise and reads as "stuck".
function postIngest(form, onProgress) {
  uploadsInFlight += 1;
  const done = (fn) => (...a) => { uploadsInFlight = Math.max(0, uploadsInFlight - 1); return fn(...a); };
  return new Promise((resolveRaw, rejectRaw) => {
    const resolve = done(resolveRaw);
    const reject = done(rejectRaw);
    const xhr = new XMLHttpRequest();
    const fail = (msg, status) => {
      if (status === 401) $('#auth-form').hidden = false;
      const err = new Error(msg);
      err.status = status;
      reject(err);
    };
    xhr.open('POST', '/api/ingest');
    xhr.upload.addEventListener('progress', (e) => {
      onProgress(e.lengthComputable ? e.loaded / e.total : null, e.loaded, e.total);
    });
    xhr.addEventListener('load', () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && data) resolve(data);
      else fail((data && data.error) || `${xhr.status} ${xhr.statusText || 'upload failed'}`, xhr.status);
    });
    // status 0 = the request never reached the server (offline, DNS, TLS, tailnet blocked).
    xhr.addEventListener('error', () => fail('network error — check the connection', 0));
    xhr.addEventListener('abort', () => fail('upload cancelled', 0));
    xhr.addEventListener('timeout', () => fail('upload timed out', 0));
    xhr.send(form);
  });
}

// Worth keeping the audio and trying again later vs. a real rejection the server
// will never accept. Authentication can be restored, so 401/403 must keep audio too.
function isTransientUploadError(err) {
  const s = err && err.status;
  return s === 0 || s === undefined || s === 401 || s === 403 || s === 408 || s === 429 || s >= 500;
}

// Returns 'ok' | 'offline' | 'rejected'. 'offline' means the audio is safe in the
// outbox and the caller should stop trying the rest of the queue for now.
async function uploadAudio(blobOrFile, filename, source, existingDiv, opts = {}) {
  const form = new FormData();
  form.append('source', source);
  form.append('audio', blobOrFile, filename);

  const size = blobOrFile.size || 0;
  const div = existingDiv || feedItem('');
  const setLine = (t) => { div.textContent = t; };
  const setHtml = (h) => { div.innerHTML = h; };
  setLine(`Uploading "${filename}"${size ? ` (${mb(size)})` : ''}…`);

  try {
    const note = await postIngest(form, (frac, loaded, total) => {
      if (frac === null) {
        setLine(`Uploading "${filename}" — ${mb(loaded)} sent…`);
      } else if (frac >= 1) {
        setLine(`Uploaded ${mb(total)} — server is receiving it…`);
        setRecordStatus('uploaded — processing');
      } else {
        setLine(`Uploading "${filename}" — ${Math.round(frac * 100)}% of ${mb(total)}`);
        setRecordStatus(`uploading ${Math.round(frac * 100)}%`);
      }
    });
    // Only drop the offline copy once the server has confirmed a note id.
    if (opts.outboxId != null) await outboxRemove(opts.outboxId);
    setLine(`Saved — processing "${filename}"`);
    watchNote(note.id, div);
    refreshHealth();
    return 'ok';
  } catch (err) {
    if (!isTransientUploadError(err)) {
      // A real reject (bad payload, 4xx) will never succeed — don't retry forever.
      if (opts.outboxId != null) await outboxRemove(opts.outboxId);
      setHtml(`${ic('alert')}Upload rejected: ${esc(err.message)} <span class="muted">("${esc(filename)}" discarded)</span>`);
      return 'rejected';
    }
    if (opts.outboxId != null) {
      setHtml(`${ic('cloud-off')}Still offline — "${esc(filename)}" is saved and waiting`);
      return 'offline';
    }
    try {
      const id = await outboxAdd({ blob: blobOrFile, filename, source, created_at: Date.now() });
      outboxLines.set(id, div);
      setHtml(`${ic('cloud-off')}Saved offline — "${esc(filename)}" will upload when you're back online`);
      // Reflect the queue immediately — waiting for the next timer tick reads as nothing happened.
      outboxList().then((all) => setOutboxBanner(all.length)).catch(() => {});
      scheduleOutboxFlush();
      return 'offline';
    } catch (storeErr) {
      setHtml(`${ic('alert')}Upload failed and could not be saved offline: ${esc(err.message)}`);
      return 'rejected';
    }
  }
}

// ---------- offline outbox (IndexedDB) ----------
// A recording made while the tailnet/Wi-Fi is blocked used to be lost outright.
// The blob lives in IndexedDB (localStorage can't hold blobs) until the server
// confirms a note id. Retry runs in the PAGE, never the service worker — sw.js
// must stay GET-only or Safari truncates POST bodies.
const OUTBOX_DB = 'second-brain-outbox';
const OUTBOX_STORE = 'pending';
const CHUNK_STORE = 'chunks'; // in-progress recording segments, see the chunk store below
const outboxLines = new Map(); // outbox id -> feed element, so retries reuse one line

function outboxOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OUTBOX_DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
        db.createObjectStore(OUTBOX_STORE, { keyPath: 'id', autoIncrement: true });
      }
      // v2: durable copy of a recording still in progress.
      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        const store = db.createObjectStore(CHUNK_STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('session', 'session', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB unavailable'));
  });
}

async function idbTx(storeName, mode, run) {
  const db = await outboxOpen();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const req = run(tx.objectStore(storeName));
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error(`${storeName} transaction aborted`));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
    });
  } finally {
    db.close();
  }
}

function outboxTx(mode, run) {
  return idbTx(OUTBOX_STORE, mode, run);
}

const outboxAdd = (rec) => outboxTx('readwrite', (store) => store.add(rec));
const outboxRemove = (id) => outboxTx('readwrite', (store) => store.delete(id));
const outboxList = () => outboxTx('readonly', (store) => store.getAll());
const outboxPut = (rec) => outboxTx('readwrite', (store) => store.put(rec));

// iOS can evict a Blob's backing data while leaving its IndexedDB record intact.
// The record then looks perfectly fine — it still has a filename and often a
// non-zero .size — but reading it yields nothing, so FormData serializes to a
// zero-length body and the server sees "Unexpected end of form". That failure is
// a 5xx, which the retry logic treats as transient, so a recording whose audio
// no longer exists gets re-sent every 30s forever while the banner insists it is
// "retrying automatically". Read a byte before trusting the blob.
async function blobIsReadable(blob) {
  if (!blob || typeof blob.slice !== 'function') return false;
  if (blob.size === 0) return false;
  try {
    const head = await blob.slice(0, 1).arrayBuffer();
    return head.byteLength === 1;
  } catch {
    return false;
  }
}

// ---------- durable chunk store (a recording still in progress) ----------
// The outbox above protects a FINISHED recording. Nothing protected an
// unfinished one: the chunks lived in a JS array, so when iOS suspended the tab
// — screen blanked, power button, app switched away, Low Power Mode refusing the
// wake lock — the audio went with the page. Every few seconds of audio is now
// written to IndexedDB; whatever was captured before the tab died is reassembled
// on the next load and handed to the outbox.
//
// Kept deliberately simple: append-only records, ordered by `seq`, concatenated
// back in order. MediaRecorder's output is a container written progressively, so
// the concatenation of a prefix of its chunks IS a valid (shorter) file — the
// first chunk carries the header. Losing the tail costs the last few seconds,
// not the recording.
const CHUNK_FLUSH_MS = 5000;

let chunkSession = null;   // { id, mime, filename, startedAt, seq }
let chunkBuffer = [];      // captured but not yet written
let chunkFlushTimer = null;
let chunkPersistFailed = false;

function startChunkSession(mime, filename) {
  chunkPersistFailed = false;
  chunkBuffer = [];
  chunkSession = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    mime,
    filename,
    startedAt: Date.now(),
    seq: 0,
  };
  return chunkSession;
}

function bufferChunk(blob) {
  if (chunkSession && !chunkPersistFailed) chunkBuffer.push(blob);
}

function startChunkFlushTimer() {
  stopChunkFlushTimer();
  chunkFlushTimer = setInterval(flushChunks, CHUNK_FLUSH_MS);
}

function stopChunkFlushTimer() {
  clearInterval(chunkFlushTimer);
  chunkFlushTimer = null;
}

async function flushChunks() {
  if (!chunkSession || chunkPersistFailed || !chunkBuffer.length) return;
  const session = chunkSession;
  const parts = chunkBuffer;
  chunkBuffer = [];
  const seq = session.seq++;
  try {
    await idbTx(CHUNK_STORE, 'readwrite', (store) => store.add({
      session: session.id,
      seq,
      mime: session.mime,
      filename: session.filename,
      startedAt: session.startedAt,
      blob: new Blob(parts, { type: session.mime }),
    }));
  } catch {
    // A failed write (quota, private mode, evicted store) leaves a HOLE in the
    // middle of the stream, and a media container with a hole reassembles into
    // garbage — worse than no backup, because it looks recoverable. Throw the
    // partial away and say the safety net is off. The in-memory copy, which is
    // still the primary path, is unaffected.
    chunkPersistFailed = true;
    await discardChunkSession(session);
    setRecordHint();
  }
}

// Called when the page is about to be hidden or frozen. requestData() makes the
// recorder hand over everything it is holding rather than waiting for its next
// timeslice, so the durable copy is as close to "now" as it can be.
function flushRecordingToDisk() {
  if (!isRecording()) return;
  try { mediaRecorder.requestData(); } catch {}
  flushChunks();
}

async function discardChunkSession(session) {
  const id = session && session.id;
  if (!id) return;
  if (chunkSession && chunkSession.id === id) {
    chunkSession = null;
    chunkBuffer = [];
  }
  try {
    await idbTx(CHUNK_STORE, 'readwrite', (store) => {
      const idx = store.index('session');
      const req = idx.openKeyCursor(IDBKeyRange.only(id));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        store.delete(cursor.primaryKey);
        cursor.continue();
      };
      return null;
    });
  } catch { /* nothing to do — a stale record is retried next load, not fatal */ }
}

// On load, any session still sitting in the store is one whose page died mid
// recording. Reassemble it and hand it to the outbox, which already knows how to
// upload, retry and report. A session that survived a SUCCESSFUL upload (the page
// died in the sliver between the server confirming and the delete landing) would
// arrive as a duplicate note — that trade is deliberate: a duplicate is a click to
// delete, a lost recording is gone.
async function recoverChunkSessions() {
  let records;
  try { records = await idbTx(CHUNK_STORE, 'readonly', (store) => store.getAll()); } catch { return; }
  if (!records || !records.length) return;

  const sessions = new Map();
  for (const rec of records) {
    if (chunkSession && rec.session === chunkSession.id) continue; // the live one
    if (!sessions.has(rec.session)) sessions.set(rec.session, []);
    sessions.get(rec.session).push(rec);
  }

  let recovered = 0;
  for (const [id, parts] of sessions) {
    parts.sort((a, b) => a.seq - b.seq);
    const head = parts[0];
    const mime = head.mime || 'audio/webm';
    const blob = new Blob(parts.map((p) => p.blob), { type: mime });
    // Same eviction trap as the outbox: iOS can drop a blob's backing bytes and
    // leave the record looking healthy. Uploading that sends an empty body.
    if (await blobIsReadable(blob)) {
      const base = (head.filename || `recording-${new Date(head.startedAt || Date.now()).toISOString().replace(/[:.]/g, '-')}.${extFor(mime)}`);
      const dot = base.lastIndexOf('.');
      const filename = dot > 0 ? `${base.slice(0, dot)}-recovered${base.slice(dot)}` : `${base}-recovered`;
      try {
        const outboxId = await outboxAdd({
          blob, filename, source: 'live', created_at: head.startedAt || Date.now(), recovered: true,
        });
        const secs = Math.max(1, parts.length * Math.round(CHUNK_FLUSH_MS / 1000));
        outboxLines.set(outboxId, feedItem(''));
        outboxLines.get(outboxId).innerHTML =
          `${ic('archive')}Recovered a recording that was interrupted — ` +
          `about ${secs < 60 ? `${secs}s` : `${Math.round(secs / 60)} min`} of audio, uploading now`;
        recovered++;
      } catch {
        continue; // leave the chunks in place; next load tries again
      }
    }
    await discardChunkSession({ id });
  }
  if (recovered) flushOutbox();
}

let outboxFlushing = false;
let outboxTimer = null;

function scheduleOutboxFlush() {
  if (outboxTimer) return;
  outboxTimer = setInterval(flushOutbox, 30000);
}

function stopOutboxFlush() {
  clearInterval(outboxTimer);
  outboxTimer = null;
}

function setOutboxBanner(count, dead = 0) {
  const el = $('#outbox-banner');
  if (!el) return;
  el.hidden = count === 0 && dead === 0;
  if (count) {
    el.innerHTML = `${ic('cloud-off')}${count} recording${count === 1 ? '' : 's'} saved offline — ` +
      `retrying automatically <button class="btn" id="outbox-retry">Retry now</button>`;
    $('#outbox-retry').addEventListener('click', (e) => {
      e.target.disabled = true;
      flushOutbox().finally(() => { e.target.disabled = false; });
    });
  } else if (dead) {
    // Never claim to be retrying something that can't succeed — that was the
    // whole reason a dead upload looked like a broken button for hours.
    el.innerHTML = `${ic('alert')}${dead} recording${dead === 1 ? '' : 's'} could not be uploaded — ` +
      `the audio is no longer readable on this device. ` +
      `<button class="btn" id="outbox-clear">Dismiss</button>`;
    $('#outbox-clear').addEventListener('click', async (e) => {
      e.target.disabled = true;
      const all = await outboxList().catch(() => []);
      for (const it of all) if (it.dead) await outboxRemove(it.id).catch(() => {});
      const rest = await outboxList().catch(() => []);
      setOutboxBanner(rest.filter((i) => !i.dead).length, rest.filter((i) => i.dead).length);
    });
  }
}

async function flushOutbox() {
  if (outboxFlushing) return;
  outboxFlushing = true;
  try {
    let items;
    try { items = await outboxList(); } catch { return; }
    const live = items.filter((i) => !i.dead);
    setOutboxBanner(live.length, items.length - live.length);
    if (!live.length) { stopOutboxFlush(); return; }

    for (const item of items) {
      if (item.dead) continue; // audio is gone; kept on purpose, see below
      let div = outboxLines.get(item.id);
      if (!div || !div.isConnected) {
        div = feedItem('');
        outboxLines.set(item.id, div);
      }

      // Uploading an unreadable blob sends an empty body and fails forever.
      // The record is KEPT, not deleted — a lost recording should be visible,
      // not silently disappear — but it stops being retried.
      if (!(await blobIsReadable(item.blob))) {
        try { await outboxPut({ ...item, dead: true }); } catch {}
        div.innerHTML = `${ic('alert')}"${esc(item.filename)}" can't be uploaded — ` +
          `the audio is no longer readable on this device, so it won't be retried.`;
        outboxLines.delete(item.id);
        continue;
      }

      const result = await uploadAudio(item.blob, item.filename, item.source, div, { outboxId: item.id });
      if (result === 'offline') break; // still no connection — leave the rest queued
      outboxLines.delete(item.id);
    }

    const remaining = await outboxList().catch(() => []);
    const stillLive = remaining.filter((i) => !i.dead).length;
    setOutboxBanner(stillLive, remaining.length - stillLive);
    if (stillLive) scheduleOutboxFlush(); else stopOutboxFlush();
  } finally {
    outboxFlushing = false;
  }
}

window.addEventListener('online', flushOutbox);
flushOutbox();
recoverChunkSessions();

// ---------- file upload ----------
// Multi-select is allowed. Every file gets its own feed line up front so the
// queue is visible, then they upload one at a time (parallel uploads on a phone
// just make each one slower and the progress meaningless).
$('#file-input').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  // Built back-to-front because feedItem prepends — this leaves file 1 on top.
  const lines = new Array(files.length);
  for (let i = files.length - 1; i >= 0; i--) {
    lines[i] = feedItem(i === 0
      ? `Uploading "${files[i].name}"…`
      : `Queued "${files[i].name}" (${mb(files[i].size)}) — ${i} ahead of it`);
  }
  for (let i = 0; i < files.length; i++) {
    await uploadAudio(files[i], files[i].name, 'upload', lines[i]);
    for (let j = i + 1; j < files.length; j++) {
      const ahead = j - i - 1;
      lines[j].textContent = ahead
        ? `Queued "${files[j].name}" (${mb(files[j].size)}) — ${ahead} ahead of it`
        : `Queued "${files[j].name}" (${mb(files[j].size)}) — next up`;
    }
  }
});

// ---------- text ingest ----------
$('#text-submit').addEventListener('click', async () => {
  const text = $('#text-input').value.trim();
  if (!text) return;
  const res = await apiFetch('/api/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (res.ok) {
    const note = await res.json();
    $('#text-input').value = '';
    watchNote(note.id, feedItem('Saved — processing text note'));
    refreshHealth();
  } else {
    feedItem('').innerHTML = `${ic('alert')}Could not save note`;
  }
});

// ---------- capture feed + note watching ----------
function feedItem(text) {
  const div = document.createElement('div');
  div.className = 'note-card';
  div.textContent = text;
  $('#capture-feed').prepend(div);
  // Room for a whole multi-file batch — evicting a line that's still uploading
  // would look like the upload vanished.
  while ($('#capture-feed').children.length > 25) $('#capture-feed').lastChild.remove();
  return div;
}

// Monochrome line icons (no emoji, per house style).
const ICONS = {
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  'cloud-off': '<path d="m2 2 20 20"/><path d="M5.8 8.1A5 5 0 0 0 7 18h9a4 4 0 0 0 2.4-.8"/><path d="M21.6 15.2A4 4 0 0 0 18 9h-1.3A7 7 0 0 0 9 5.3"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/>',
};
function ic(name) {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ` +
    `stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ` +
    `style="vertical-align:-3px;margin-right:6px">${ICONS[name]}</svg>`;
}

// Processing takes ~20-60s; show elapsed time so a long stage never reads as frozen.
async function watchNote(id, existingDiv) {
  const div = existingDiv || feedItem('waiting…');
  const startedAt = Date.now();
  const elapsed = () => `${Math.round((Date.now() - startedAt) / 1000)}s`;
  const poll = async () => {
    try {
      const res = await apiFetch(`/api/notes/${id}`);
      if (!res.ok) throw new Error('Note unavailable');
      const n = await res.json();
      if (n.status === 'ready') {
        div.innerHTML = `${ic('check')}<strong>${esc(n.title || 'Note saved')}</strong>` +
          (n.category_path ? ` <span class="tag cat">${esc(n.category_path)}</span>` : '');
        return;
      }
      if (n.status === 'error') {
        div.innerHTML = `${ic('alert')}${esc(n.error || 'Processing failed')} <button class="btn" onclick="retryNote('${id}', this)">Retry</button>`;
        return;
      }
      div.innerHTML = `${ic('clock')}${esc(n.status)}… <span class="muted">${elapsed()}</span>`;
      setTimeout(poll, 2500);
    } catch { setTimeout(poll, 5000); }
  };
  poll();
}

window.retryNote = async (id, btn) => {
  if (btn) btn.disabled = true;
  await apiFetch(`/api/notes/${id}/process`, { method: 'POST' });
  watchNote(id);
};

// ---------- notes tab ----------
let searchTimer = null;
$('#search-input').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(refreshNotes, 250);
});
$('#category-filter').addEventListener('change', refreshNotes);

async function loadCategories() {
  try {
    const { categories } = await (await apiFetch('/api/categories')).json();
    const byId = Object.fromEntries(categories.map((c) => [c.id, c]));
    const pathOf = (c) => (c.parent_id ? `${pathOf(byId[c.parent_id])} / ${c.name}` : c.name);
    const sel = $('#category-filter');
    const current = sel.value;
    sel.innerHTML = '<option value="">All categories</option>' +
      categories.map((c) => `<option value="${c.id}">${esc(pathOf(c))}</option>`).join('');
    sel.value = current;
    // The Tasks filter matches on the category PATH (a parent includes its
    // children), so it gets paths rather than ids.
    const tsel = $('#task-category');
    const tcurrent = tsel.value;
    const paths = categories.map(pathOf).sort();
    tsel.innerHTML = '<option value="">All categories</option>' +
      paths.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
    tsel.value = tcurrent;
  } catch { /* ignore */ }
}
loadCategories();

let notesOffset = 0;
let notesGeneration = 0;
// Offsets shift when a note arrives between pages (newest-first), so Load more
// can hand back a note that is already on screen. Skip what is already shown.
const shownNoteIds = new Set();
const NOTES_PAGE_SIZE = 100;
$('#notes-more').addEventListener('click', () => refreshNotes(true));

async function refreshNotes(append = false) {
  append = append === true;
  loadCategories();
  const generation = append ? notesGeneration : ++notesGeneration;
  if (!append) notesOffset = 0;
  const more = $('#notes-more');
  more.disabled = true;
  const q = $('#search-input').value.trim();
  const cat = $('#category-filter').value;
  const params = new URLSearchParams({ limit: NOTES_PAGE_SIZE, offset: notesOffset });
  if (cat) params.set('category', cat);
  if (q) params.set('q', q);
  try {
    const res = await apiFetch(`/api/notes${q ? '/search' : ''}?${params}`);
    if (!res.ok) return;
    const notes = await res.json();
    if (generation !== notesGeneration) return;
    const list = $('#notes-list');
    if (!append) { list.innerHTML = ''; shownNoteIds.clear(); }
    notesOffset += notes.length;
    more.hidden = notes.length < NOTES_PAGE_SIZE;
    if (!notesOffset) {
      list.innerHTML = '<div class="empty">Nothing here yet. Go say something.</div>';
      return;
    }
    const fresh = notes.filter((n) => !shownNoteIds.has(n.id));
    for (const n of fresh) shownNoteIds.add(n.id);
    list.insertAdjacentHTML('beforeend', fresh.map(noteCard).join(''));
    $$('.note-card[data-id]').forEach((card) => {
      card.onclick = () => openNote(card.dataset.id);
    });
  } finally {
    if (generation === notesGeneration) more.disabled = false;
  }
}

function statusTag(n) {
  if (n.status === 'ready') return '';
  if (n.status === 'error') return '<span class="tag status-error">error</span>';
  return `<span class="tag status-working">${esc(n.status)}…</span>`;
}

function noteCard(n) {
  const date = new Date(n.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const preview = n.summary || (n.transcript ? n.transcript.slice(0, 160) + (n.transcript.length > 160 ? '…' : '') : '');
  return `<div class="note-card" data-id="${n.id}">
    <div class="title">${esc(n.title || 'Untitled note')}</div>
    <div class="summary">${esc(preview)}</div>
    <div class="meta">
      <span>${esc(date)}</span>
      ${n.category_path ? `<span class="tag cat">${esc(n.category_path)}</span>` : ''}
      ${statusTag(n)}
      ${(n.tags || []).slice(0, 4).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
    </div>
  </div>`;
}

// ---------- tasks tab ----------
// Every action item the categorizer pulled out of a note, with state on it.
const TASK_NEXT = { open: 'working', working: 'done', done: 'open', dropped: 'open' };

$('#task-category').addEventListener('change', refreshTasks);
$('#task-state').addEventListener('change', refreshTasks);

async function refreshTasks() {
  const list = $('#tasks-list');
  list.innerHTML = '<div class="empty">Loading…</div>';
  const states = $('#task-state').value;
  const cat = $('#task-category').value;
  const scope = cat ? `&category=${encodeURIComponent(cat)}` : '';
  let tasks;
  try {
    const res = await apiFetch(`/api/tasks?state=${states}${scope}`);
    if (!res.ok) { list.innerHTML = '<div class="empty">Unlock the app to view tasks.</div>'; return; }
    ({ tasks } = await res.json());
  } catch {
    list.innerHTML = '<div class="empty">Could not reach the server.</div>';
    return;
  }
  if (!tasks.length) {
    list.innerHTML = '<div class="empty">Nothing here. Clear.</div>';
    return;
  }
  // Grouped under their note — an action item read on its own loses the thing
  // that makes it intelligible, which is what was being talked about.
  const groups = [];
  const byNote = new Map();
  for (const t of tasks) {
    if (!byNote.has(t.note_id)) {
      const g = { id: t.note_id, title: t.note_title, date: t.note_created_at, items: [] };
      byNote.set(t.note_id, g);
      groups.push(g);
    }
    byNote.get(t.note_id).items.push(t);
  }
  list.innerHTML = groups.map(taskGroup).join('');
  $$('#tasks-list .task-row').forEach((row) => {
    row.querySelector('.task-check').addEventListener('click', (e) => {
      e.stopPropagation();
      cycleTask(row.dataset.id, row.dataset.state);
    });
    row.querySelector('.task-open').addEventListener('click', () => openNote(row.dataset.noteId));
  });
}

function taskGroup(g) {
  const date = new Date(g.date).toLocaleDateString(undefined, { dateStyle: 'medium' });
  return `<div class="task-group">
    <div class="task-group-head"><span>${esc(g.title || 'Untitled note')}</span><span class="muted">${esc(date)}</span></div>
    ${g.items.map(taskRow).join('')}
  </div>`;
}

function taskRow(t) {
  const mark = { open: '', working: ic('clock'), done: ic('check'), dropped: '—' }[t.state] || '';
  return `<div class="task-row state-${esc(t.state)}" data-id="${esc(t.id)}" data-state="${esc(t.state)}" data-note-id="${esc(t.note_id)}">
    <button class="task-check" title="open → working → done" aria-label="Change state">${mark}</button>
    <div class="task-text">${esc(t.text)}${t.note ? `<span class="task-note">${esc(t.note)}</span>` : ''}</div>
    <button class="task-open" title="Open the note">Note</button>
  </div>`;
}

async function cycleTask(id, state) {
  const next = TASK_NEXT[state] || 'open';
  await apiFetch(`/api/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: next }),
  });
  refreshTasks();
}

// ---------- note modal ----------
let modalNoteId = null;
async function openNote(id) {
  const res = await apiFetch(`/api/notes/${id}`);
  if (!res.ok) return;
  const n = await res.json();
  modalNoteId = id;
  const date = new Date(n.created_at).toLocaleString();
  $('#note-modal-body').innerHTML = `
    <h2>${esc(n.title || 'Untitled note')}</h2>
    <div class="meta">${esc(date)} · ${esc(n.source)} · ${esc(n.status)}${n.category_path ? ' · ' + esc(n.category_path) : ''}</div>
    ${n.summary ? `<p>${esc(n.summary)}</p>` : ''}
    ${n.action_items?.length ? `<h4 style="margin-top:12px">Action items</h4><ul>${n.action_items.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}
    ${n.error ? `<p style="color:var(--danger);margin-top:10px">${ic('alert')}${esc(n.error)}</p>` : ''}
    ${n.audio_path
      ? `<audio controls src="/api/notes/${n.id}/audio"></audio>`
      : n.audio_pruned_at
        ? `<p class="muted" style="margin-top:10px">${ic('archive')}Audio pruned ${esc(n.audio_pruned_at.slice(0, 10))} to save space — the transcript below is the record.</p>`
        : ''}
    ${n.transcript ? `<div class="transcript">${esc(n.transcript)}</div>` : ''}
  `;
  $('#note-modal').showModal();
}
$('#note-close').addEventListener('click', () => $('#note-modal').close());
$('#note-retry').addEventListener('click', async () => {
  if (!modalNoteId) return;
  await apiFetch(`/api/notes/${modalNoteId}/process`, { method: 'POST' });
  $('#note-modal').close();
  refreshNotes();
});
$('#note-delete').addEventListener('click', async () => {
  if (!modalNoteId || !confirm('Delete this note (and its audio) permanently?')) return;
  await apiFetch(`/api/notes/${modalNoteId}`, { method: 'DELETE' });
  $('#note-modal').close();
  refreshNotes();
  refreshHealth();
});

// ---------- chat ----------
const chatHistory = [];
$('#chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  chatHistory.push({ role: 'user', content: text });
  addChatMsg('user', text);
  const pending = addChatMsg('assistant thinking', 'searching your notes…');
  try {
    const res = await apiFetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: chatHistory }),
    });
    const data = await res.json();
    pending.remove();
    if (!res.ok) throw new Error(data.error || res.statusText);
    chatHistory.push({ role: 'assistant', content: data.reply });
    addChatMsg('assistant', data.reply);
  } catch (err) {
    pending.remove();
    addChatMsg('assistant', `Error: ${err.message}`);
  }
});

// Models answer in light markdown. Escape everything first, then allow only
// bold, inline code, and bullet lines, so a note's text can never inject markup.
function renderReply(text) {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^\s*[-*] (.+)$/gm, '• $1');
}

function addChatMsg(cls, text) {
  const div = document.createElement('div');
  div.className = `chat-msg ${cls}`;
  if (cls === 'assistant') div.innerHTML = renderReply(text);
  else div.textContent = text;
  $('#chat-thread').appendChild(div);
  div.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return div;
}

// ---------- utils ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- PWA ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
