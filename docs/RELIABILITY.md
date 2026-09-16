# Why it's built this way

Second Brain started as one person's daily tool, and most of the code that isn't the pipeline
exists because something failed for real. This is the list: what broke, how it showed up, and
what the code does now. Each section names the file and the test that guards it.

## Recording on a phone

### Capture stops when the app leaves the foreground

**What happened.** iOS cuts audio capture the moment a home-screen web app stops being frontmost.
The app kept its timer running, so it looked like recording had continued. Measured from real
notes, comparing wall-clock time against audio actually in the file:

| Note | Wall clock | Audio captured |
| --- | --- | --- |
| stayed in the app | 318.9s | 315.0s |
| left the app | 60.2s | 6.0s |
| left the app | 66.3s | 19.1s |

The recording didn't "stop after a minute". It stopped when the app was backgrounded, and the app
then claimed audio that never existed.

**What the code does.** The timer counts captured audio, never wall clock: the recorder hands over
a chunk every timeslice even in silence, so four seconds with no chunk means capture is dead. A
recording is a session of segments. When capture is taken away, the segment is closed and
uploaded, and a new one starts when the app is frontmost again. Nothing is lost; an interrupted
session arrives as several notes instead of one truncated one.
`public/app.js` (segments, `captureStalled`), `scripts/test_recording_recovery.mjs`.

### The screen turning off ends the recording

**What happened.** A suspended tab's recorder stops delivering data, and the audio lived only in
memory, so it died with the page.

**What the code does.** Two layers, because either alone leaves a hole. A screen wake lock is held
while recording, and re-requested every time the page becomes visible, because iOS releases it
whenever the page hides. The wake lock is refused outright in Low Power Mode, so every five
seconds of audio is also written to IndexedDB. If the page dies, the next load reassembles the
chunks in order and uploads them. A prefix of the chunks is a valid, shorter file, so an
interruption costs the tail, not the recording. The durable copy is deleted only after the server
confirms the upload. The hint under the record button says whether the wake lock was granted,
because a silently refused lock behaves exactly like the original bug.
`scripts/test_recording_recovery.mjs` closes a real browser page mid-recording and checks that the
recovered file decodes to about the right length.

### An upload that retried forever

**What happened.** iOS can evict a stored recording's data while keeping its record. The record
still looked fine, but it uploaded as an empty body, the server answered 500, the client treated
500 as "try again", and it retried every 30 seconds indefinitely while the banner said "retrying
automatically".

**What the code does.** The server's status code is the whole contract, and it turns on one
question: could this request have carried audio? An empty body (`Content-Length: 0`, or a 0-byte
file part) gets a 400, which the client treats as final. Real bytes followed by a dropped
connection get a 503, which the client keeps and retries. The client also reads one byte of a
queued recording before sending it; an unreadable one is marked dead and kept visible rather than
deleted. `server/routes.js` (`ingestUpload`).

### A truncated recording is recoverable

**What happened.** An upload cut off mid-transfer produced a file ffprobe called unreadable ("moov
atom not found").

**What the code does.** iOS records fragmented MP4, where every fragment carries its own sample
table; only the header is missing. `scripts/recover_truncated_m4a.py` (Python 3, no packages) rebuilds it using a healthy
recording from the same device as a reference. Partial uploads are moved to
`DATA_DIR/orphan-audio-quarantine/` rather than deleted, so this stays possible.

### The phone runs old code after an update

**What happened.** A home-screen web app keeps its page alive across launches, so after an update
the phone can run the previous version for days. Testing a fix on a stale page looks exactly like
the fix not working.

**What the code does.** `/api/health` returns a fingerprint of the front-end files, hashed from the
same folder they're served from. The page remembers the fingerprint it started with and reloads
when the server's changes, but never mid-recording or mid-upload. The status pill shows the
running version, so "which code is the phone on?" takes one glance.

## The server

### A synchronous call can get a healthy server killed

**What happened.** Splitting a long recording with ffmpeg took 19.4 seconds per 20 minutes of
audio. Run synchronously, it froze the whole server, long enough for a health check to decide the
server was dead and restart it in the middle of the job.

**What the code does.** Nothing in a request or job path is synchronous: `node:fs/promises` and
`spawn`, never `*Sync()`. `scripts/test_event_loop_free.mjs` splits a 40-minute recording and fails
if the event loop ever stalls for more than a second.

### Retries only where a retry can help

A rate limit or a dropped connection shouldn't cost a note; a bad key or corrupt audio should fail
at once with a clear message. `server/retry.js` retries 408/409/425/429/5xx and network errors, three
attempts with jittered backoff, and nothing else. Long recordings are retried per segment, so one
failed chunk doesn't redo an hour of audio. `scripts/test_retry.mjs`,
`scripts/test_transcribe_retry.mjs`.

### Long recordings arrive in order

Recordings over 25 MB are split into 10-minute segments. The segment names are zero-padded, so
segment 10 sorts after segment 9. `scripts/test_transcribe_chunking.mjs` builds a 125-minute file on
purpose, because naive sorting only goes wrong past nine segments.

## Your data

### Action items keep their state

Each action item is its own row, identified by its note and its text, not its position. Re-filing a
note reorders items freely, and a position-keyed row would hand a finished item's state to whatever
slid into its slot. Only untouched items are ever removed. `scripts/test_task_items.mjs`.

### Old audio goes, transcripts stay

`scripts/prune_audio.mjs` deletes audio older than `AUDIO_RETENTION_DAYS` and keeps the transcript;
the note says "audio pruned" and the audio route answers 410, not 404. It refuses to run if more
than half the files look orphaned, because that means paths are wrong, not that the audio is junk.

### A backup nobody has opened is a hope

`scripts/backup_db.mjs` takes a hot snapshot with `VACUUM INTO` and discards it unless an integrity
check passes. `scripts/verify_backups.mjs` re-opens snapshots where they live, including a synced
copy, because a sync client can evict or corrupt a file after it was written.

### What it costs is measured, not guessed

Every model call writes a row with the tokens the provider reported, and every transcription
records the audio minutes the transcription service returned. `npm run costs` totals them. Costs
are list-price estimates, and a call with no known price is counted as unpriced rather than as
zero, so a partial total can't pass for a whole one.

## Authentication, cleanup, and finding older notes

The browser can unlock an authenticated install with its access token. An HttpOnly session
cookie authenticates API requests, uploads, and native audio playback. A 401 or 403 leaves
recordings queued so signing in again can't discard them.

Multipart uploads are written to `data/uploads/`. Once complete, ingest reserves the final
path in the database before moving the file into `data/audio/`. Cleanup only examines audio,
and rechecks references before deleting an orphan, covering uploads completed after its
initial snapshot. Interrupted staging files are retained outside the retention sweep.

Category search filters in SQL before applying the result limit. Browse and search both
support offsets and stable tie-breaking, and the UI offers Load more for subsequent pages.

`scripts/test_review_regressions.mjs` guards authentication and playback, queued audio after
401, cleanup during an open multipart upload, category filtering, and API/UI pagination.
