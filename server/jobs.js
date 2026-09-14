import fsp from 'node:fs/promises';
import path from 'node:path';
import { uploadDir } from './config.js';
import { getNote, updateNote, notesByStatus } from './db.js';
import { transcribeAudio, transcriptionAvailable } from './transcribe.js';
import { categorizeNote, categorizerAvailable } from './agents/categorizer.js';

// A tiny in-process pipeline: notes move captured -> transcribing -> categorizing -> ready.
// One note is processed at a time so a burst of uploads doesn't hammer the APIs.

const queue = [];
let running = false;

export function enqueue(noteId) {
  if (!queue.includes(noteId)) queue.push(noteId);
  drain();
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const id = queue.shift();
      await processNote(id).catch((err) => {
        console.error(`[jobs] note ${id} failed:`, err.message);
      });
    }
  } finally {
    running = false;
  }
}

async function processNote(id) {
  let note = getNote(id);
  if (!note) return;

  try {
    // 1. Transcribe (audio notes without a transcript yet)
    if (!note.transcript && note.audio_path) {
      if (!transcriptionAvailable()) {
        updateNote(id, {
          status: 'error',
          error: 'Audio stored, but no transcription key is set (OPENAI_API_KEY or TRANSCRIBE_API_KEY). Set one and hit "retry".',
        });
        return;
      }
      updateNote(id, { status: 'transcribing', error: null });
      const transcript = await transcribeAudio(note.audio_path, note.audio_mime, id);
      note = updateNote(id, { transcript });
    }

    if (!note.transcript || !note.transcript.trim()) {
      updateNote(id, { status: 'error', error: 'No transcript could be produced for this note.' });
      return;
    }

    // 2. Categorize (skipped when no model provider is set: the note is still stored and searchable)
    if (categorizerAvailable()) {
      updateNote(id, { status: 'categorizing', error: null });
      await categorizeNote(getNote(id));
    }

    updateNote(id, { status: 'ready', error: null });
  } catch (err) {
    updateNote(id, { status: 'error', error: String(err.message || err) });
    throw err;
  }
}

// Ingest reserves a note's final audio path in the DB, THEN moves the staged
// upload into audio/. A crash between the two left a note pointing at a file
// that never arrived (it failed transcription with ENOENT) while the complete
// recording sat in uploads/. Finish the move before anything is requeued.
export async function recoverReservedUploads(notes = notesByStatus(['captured', 'transcribing', 'categorizing'])) {
  let moved = 0;
  for (const n of notes) {
    if (!n.audio_path) continue;
    const exists = await fsp.access(n.audio_path).then(() => true, () => false);
    if (exists) continue;
    const staged = path.join(uploadDir, path.basename(n.audio_path));
    try {
      await fsp.rename(staged, n.audio_path);
      moved++;
      console.log(`[jobs] recovered staged upload for note ${n.id}`);
    } catch { /* nothing staged under that name: transcription reports the missing file */ }
  }
  return moved;
}

// On startup, requeue anything that was mid-pipeline when the server last stopped.
export async function resumePending() {
  const pending = notesByStatus(['captured', 'transcribing', 'categorizing']);
  await recoverReservedUploads(pending);
  for (const n of pending) enqueue(n.id);
  if (pending.length) console.log(`[jobs] resumed ${pending.length} pending note(s)`);
}
