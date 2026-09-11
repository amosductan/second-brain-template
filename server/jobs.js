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

// On startup, requeue anything that was mid-pipeline when the server last stopped.
export function resumePending() {
  const pending = notesByStatus(['captured', 'transcribing', 'categorizing']);
  for (const n of pending) enqueue(n.id);
  if (pending.length) console.log(`[jobs] resumed ${pending.length} pending note(s)`);
}
