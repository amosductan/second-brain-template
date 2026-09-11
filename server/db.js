import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const db = new DatabaseSync(path.join(config.dataDir, 'second-brain.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    source TEXT NOT NULL,             -- 'live' | 'upload' | 'text'
    status TEXT NOT NULL,             -- 'captured' | 'transcribing' | 'categorizing' | 'ready' | 'error'
    error TEXT,
    audio_path TEXT,
    audio_mime TEXT,
    audio_original_name TEXT,
    transcript TEXT,
    title TEXT,
    summary TEXT,
    category_id TEXT REFERENCES categories(id),
    tags TEXT NOT NULL DEFAULT '[]',          -- JSON array of strings
    action_items TEXT NOT NULL DEFAULT '[]'   -- JSON array of strings
  );

  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id TEXT REFERENCES categories(id),
    description TEXT,
    created_by TEXT NOT NULL DEFAULT 'seed',  -- 'seed' | 'agent' | 'user'
    created_at TEXT NOT NULL,
    UNIQUE(name, parent_id)
  );

  -- One row per action item, NOT per note. A note carries 4-7 actions and
  -- lands them in one breath; they get worked, and finished, separately. Note-
  -- level state would close a note with three of its five actions untouched.
  -- Identity is (note_id, text) rather than (note_id, idx): re-running the
  -- categorizer reorders items freely, and an index-keyed row would hand a
  -- finished item's state to whatever slid into its slot.
  CREATE TABLE IF NOT EXISTS task_items (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,             -- display order within the note only
    text TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'working' | 'done' | 'dropped'
    note TEXT,                        -- how it was closed / where it landed
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(note_id, text)
  );
  CREATE INDEX IF NOT EXISTS task_items_state ON task_items(state);

  -- One row per billed model call (a tool loop is several). Written by
  -- server/llm.js and server/transcribe.js, read by /api/usage and
  -- npm run costs. No foreign key on note_id: deleting a note must not delete
  -- the record that it cost money.
  CREATE TABLE IF NOT EXISTS model_usage (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    purpose TEXT NOT NULL,            -- 'categorize' | 'chat' | 'transcribe'
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    note_id TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    audio_seconds REAL,
    cost_usd REAL,                    -- null when the model has no known price
    cost_basis TEXT NOT NULL          -- 'estimated' (list price) | 'unpriced' | 'unmeasured'
  );
  CREATE INDEX IF NOT EXISTS model_usage_at ON model_usage(at);

  -- Long-term memory for agents: observations the categorizer records so it
  -- gets better at sorting *your* notes over time.
  CREATE TABLE IF NOT EXISTS agent_memory (
    id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    transcript, title, summary,
    content='notes', content_rowid='rowid'
  );

  CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, transcript, title, summary)
    VALUES (new.rowid, coalesce(new.transcript,''), coalesce(new.title,''), coalesce(new.summary,''));
  END;
  CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, transcript, title, summary)
    VALUES ('delete', old.rowid, coalesce(old.transcript,''), coalesce(old.title,''), coalesce(old.summary,''));
  END;
  CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, transcript, title, summary)
    VALUES ('delete', old.rowid, coalesce(old.transcript,''), coalesce(old.title,''), coalesce(old.summary,''));
    INSERT INTO notes_fts(rowid, transcript, title, summary)
    VALUES (new.rowid, coalesce(new.transcript,''), coalesce(new.title,''), coalesce(new.summary,''));
  END;
`);

// ---- migrations ----
// Audio is ~8 MB a note and grows forever, so old files get pruned while the
// transcript is kept. audio_pruned_at is how the UI tells "pruned on purpose"
// from "the file is missing and something is wrong".
const noteColumns = new Set(db.prepare('PRAGMA table_info(notes)').all().map((c) => c.name));
if (!noteColumns.has('audio_pruned_at')) {
  db.exec('ALTER TABLE notes ADD COLUMN audio_pruned_at TEXT');
}

export const newId = () => crypto.randomUUID();
export const now = () => new Date().toISOString();

// ---- seed categories (top-level + subcategories) ----
// A small starting shape. The categorizer grows it: when nothing fits, it
// proposes a new category, so after a few weeks the taxonomy is yours.
const SEED = [
  { name: 'Work', description: 'Work: projects, meetings, calls, colleagues, clients.', children: [] },
  {
    name: 'Personal',
    description: 'Personal life.',
    children: [
      { name: 'Family', description: 'Family matters and relationships.' },
      { name: 'Health', description: 'Health, fitness, wellbeing.' },
      { name: 'Friends', description: 'Friendships and social life.' },
      { name: 'Home', description: 'Running the home: errands, repairs, things to buy.' },
    ],
  },
  { name: 'Projects', description: 'Side projects, ventures, things being built.', children: [] },
  { name: 'Ideas', description: 'Ideas and musings that fit nowhere else yet.', children: [] },
];

const countCats = db.prepare('SELECT COUNT(*) AS c FROM categories').get();
if (countCats.c === 0) {
  const ins = db.prepare(
    "INSERT INTO categories (id, name, parent_id, description, created_by, created_at) VALUES (?, ?, ?, ?, 'seed', ?)"
  );
  for (const top of SEED) {
    const topId = newId();
    ins.run(topId, top.name, null, top.description, now());
    for (const child of top.children) {
      ins.run(newId(), child.name, topId, child.description, now());
    }
  }
}

// Task rows are derived from notes.action_items, so they are reconciled at boot
// rather than only when a note is written. That covers the backfill of every
// note that predates the table and any drift from a direct DB edit, and it is
// safe to repeat — see syncTaskItems.
syncAllTaskItems();

// ---- notes ----

export function insertNote({ source, audioPath = null, audioMime = null, audioOriginalName = null, transcript = null }) {
  const id = newId();
  const ts = now();
  db.prepare(`
    INSERT INTO notes (id, created_at, updated_at, source, status, audio_path, audio_mime, audio_original_name, transcript)
    VALUES (?, ?, ?, ?, 'captured', ?, ?, ?, ?)
  `).run(id, ts, ts, source, audioPath, audioMime, audioOriginalName, transcript);
  return getNote(id);
}

export function getNote(id) {
  const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
  return row ? hydrate(row) : null;
}

export function updateNote(id, fields) {
  const allowed = ['status', 'error', 'transcript', 'title', 'summary', 'category_id', 'tags', 'action_items', 'audio_path'];
  const sets = [];
  const vals = [];
  for (const key of allowed) {
    if (key in fields) {
      sets.push(`${key} = ?`);
      let v = fields[key];
      if (key === 'tags' || key === 'action_items') v = JSON.stringify(v);
      vals.push(v);
    }
  }
  if (!sets.length) return getNote(id);
  sets.push('updated_at = ?');
  vals.push(now(), id);
  db.prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  if ('action_items' in fields) syncTaskItems(id, fields.action_items || []);
  return getNote(id);
}

export function deleteNote(id) {
  db.prepare('DELETE FROM notes WHERE id = ?').run(id);
}

// ---- audio retention ----

/** Every audio path the DB still claims — used to spot orphaned files on disk. */
export function referencedAudioPaths() {
  return db.prepare('SELECT audio_path FROM notes WHERE audio_path IS NOT NULL')
    .all().map((r) => r.audio_path);
}

/**
 * Notes whose audio may be pruned: fully processed, still holding a file, and
 * older than the cutoff. Anything not 'ready' still needs its audio to
 * transcribe or retry, so it is never a candidate.
 */
export function prunableAudioNotes(cutoffIso) {
  return db.prepare(`
    SELECT id, created_at, audio_path, audio_original_name, title
    FROM notes
    WHERE status = 'ready' AND audio_path IS NOT NULL AND created_at < ?
    ORDER BY created_at ASC
  `).all(cutoffIso);
}

/** Drop the file reference but keep the note and its transcript forever. */
export function markAudioPruned(id) {
  db.prepare('UPDATE notes SET audio_path = NULL, audio_pruned_at = ?, updated_at = ? WHERE id = ?')
    .run(now(), now(), id);
}

export function listNotes({ category = null, status = null, limit = 100, offset = 0 } = {}) {
  let sql = 'SELECT * FROM notes';
  const where = [];
  const vals = [];
  if (category) { where.push('category_id = ?'); vals.push(category); }
  if (status) { where.push('status = ?'); vals.push(status); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  vals.push(limit, offset);
  return db.prepare(sql).all(...vals).map(hydrate);
}

export function notesByStatus(statuses) {
  const placeholders = statuses.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM notes WHERE status IN (${placeholders}) ORDER BY created_at ASC`).all(...statuses).map(hydrate);
}

export function searchNotes(query, { limit = 10 } = {}) {
  // Sanitize into a simple OR query of quoted terms so user input can't break FTS syntax.
  const terms = query.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '')}"`);
  if (!terms.length) return [];
  const ftsQuery = terms.join(' OR ');
  const rows = db.prepare(`
    SELECT n.*, bm25(notes_fts) AS rank
    FROM notes_fts f JOIN notes n ON n.rowid = f.rowid
    WHERE notes_fts MATCH ?
    ORDER BY rank LIMIT ?
  `).all(ftsQuery, limit);
  return rows.map(hydrate);
}

function hydrate(row) {
  return {
    ...row,
    tags: safeParse(row.tags, []),
    action_items: safeParse(row.action_items, []),
    category_path: row.category_id ? categoryPath(row.category_id) : null,
  };
}

function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

// ---- categories ----

export function listCategories() {
  return db.prepare('SELECT * FROM categories ORDER BY parent_id IS NOT NULL, name').all();
}

export function categoryPath(id) {
  const parts = [];
  let cur = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  while (cur) {
    parts.unshift(cur.name);
    cur = cur.parent_id ? db.prepare('SELECT * FROM categories WHERE id = ?').get(cur.parent_id) : null;
  }
  return parts.join(' / ');
}

export function findCategoryByPath(pathStr) {
  const parts = pathStr.split('/').map((p) => p.trim()).filter(Boolean);
  let parentId = null;
  let found = null;
  for (const name of parts) {
    found = parentId
      ? db.prepare('SELECT * FROM categories WHERE name = ? COLLATE NOCASE AND parent_id = ?').get(name, parentId)
      : db.prepare('SELECT * FROM categories WHERE name = ? COLLATE NOCASE AND parent_id IS NULL').get(name);
    if (!found) return null;
    parentId = found.id;
  }
  return found;
}

export function createCategory({ name, parentPath = null, description = null, createdBy = 'agent' }) {
  let parentId = null;
  if (parentPath) {
    const parent = findCategoryByPath(parentPath);
    if (!parent) return null;
    parentId = parent.id;
  }
  const existing = parentId
    ? db.prepare('SELECT * FROM categories WHERE name = ? COLLATE NOCASE AND parent_id = ?').get(name, parentId)
    : db.prepare('SELECT * FROM categories WHERE name = ? COLLATE NOCASE AND parent_id IS NULL').get(name);
  if (existing) return existing;
  const id = newId();
  db.prepare('INSERT INTO categories (id, name, parent_id, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, name, parentId, description, createdBy, now());
  return db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
}

export function categoryTreeText() {
  const cats = listCategories();
  const byParent = new Map();
  for (const c of cats) {
    const key = c.parent_id || 'root';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(c);
  }
  const lines = [];
  const walk = (parentKey, depth) => {
    for (const c of byParent.get(parentKey) || []) {
      lines.push(`${'  '.repeat(depth)}- ${c.name}${c.description ? ` — ${c.description}` : ''}`);
      walk(c.id, depth + 1);
    }
  };
  walk('root', 0);
  return lines.join('\n');
}

// ---- task items ----

const TASK_STATES = ['open', 'working', 'done', 'dropped'];
export const taskStates = () => [...TASK_STATES];

/**
 * Reconcile a note's task_items against its action_items. Idempotent by design:
 * matching text keeps its state, new text arrives 'open'.
 *
 * Deletion is deliberately narrow. An item that vanished from action_items but
 * is 'working'/'done' is a record of work that actually happened, so it stays
 * even though nothing points at it anymore — only untouched 'open' rows are
 * swept. That is what makes running this on every boot safe: nothing finished
 * can be resurrected as open, and nothing open can pile up as a duplicate.
 */
export function syncTaskItems(noteId, items = []) {
  const ts = now();
  const existing = db.prepare('SELECT * FROM task_items WHERE note_id = ?').all(noteId);
  const byText = new Map(existing.map((r) => [r.text, r]));
  const seen = new Set();
  const ins = db.prepare(
    'INSERT INTO task_items (id, note_id, idx, text, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const reorder = db.prepare('UPDATE task_items SET idx = ? WHERE id = ?');
  (Array.isArray(items) ? items : []).forEach((raw, idx) => {
    const text = String(raw ?? '').trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    const row = byText.get(text);
    if (row) {
      if (row.idx !== idx) reorder.run(idx, row.id);
      return;
    }
    ins.run(newId(), noteId, idx, text, 'open', ts, ts);
  });
  const del = db.prepare("DELETE FROM task_items WHERE id = ? AND state = 'open'");
  for (const row of existing) if (!seen.has(row.text)) del.run(row.id);
}

/** Backfill + drift repair for every note. Cheap (one pass, small table). */
export function syncAllTaskItems() {
  const rows = db.prepare("SELECT id, action_items FROM notes WHERE action_items NOT IN ('[]', '')").all();
  for (const r of rows) syncTaskItems(r.id, safeParse(r.action_items, []));
  return rows.length;
}

export function listTasks({ states = ['open', 'working'], category = null, tag = null, limit = 200 } = {}) {
  const wanted = states.filter((s) => TASK_STATES.includes(s));
  if (!wanted.length) return [];
  const placeholders = wanted.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT t.*, n.title AS note_title, n.created_at AS note_created_at, n.category_id, n.tags AS note_tags
    FROM task_items t JOIN notes n ON n.id = t.note_id
    WHERE t.state IN (${placeholders})
    ORDER BY n.created_at DESC, t.idx ASC
  `).all(...wanted).map((r) => ({
    ...r,
    category_path: r.category_id ? categoryPath(r.category_id) : null,
  }));
  // Filtered before the limit is applied, or a busy day in one category would
  // push every other category's items off the end of the list.
  let filtered = category
    ? rows.filter((r) => (r.category_path || '').toLowerCase().startsWith(category.toLowerCase()))
    : rows;
  if (tag) {
    // Tags live on the NOTE as a JSON array; an item inherits its note's tags.
    filtered = filtered.filter((r) => {
      try { return JSON.parse(r.note_tags || '[]').includes(tag); } catch { return false; }
    });
  }
  return filtered.slice(0, limit);
}

export function getTask(id) {
  return db.prepare('SELECT * FROM task_items WHERE id = ?').get(id) || null;
}

export function updateTask(id, { state, note } = {}) {
  const sets = [];
  const vals = [];
  if (state !== undefined) {
    if (!TASK_STATES.includes(state)) throw new Error(`Invalid task state: ${state}`);
    sets.push('state = ?');
    vals.push(state);
  }
  if (note !== undefined) { sets.push('note = ?'); vals.push(note || null); }
  if (!sets.length) return getTask(id);
  sets.push('updated_at = ?');
  vals.push(now(), id);
  db.prepare(`UPDATE task_items SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getTask(id);
}

export function taskStats() {
  const out = Object.fromEntries(TASK_STATES.map((s) => [s, 0]));
  for (const r of db.prepare('SELECT state, COUNT(*) AS c FROM task_items GROUP BY state').all()) {
    out[r.state] = r.c;
  }
  return out;
}

// ---- model usage ----

export function recordUsage(u) {
  db.prepare(`
    INSERT INTO model_usage (id, at, purpose, provider, model, note_id, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, audio_seconds, cost_usd, cost_basis)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newId(), now(), u.purpose, u.provider, u.model, u.note_id ?? null,
    u.input_tokens || 0, u.output_tokens || 0, u.cache_read_tokens || 0, u.cache_write_tokens || 0,
    u.audio_seconds ?? null, u.cost_usd ?? null, u.cost_basis,
  );
}

/**
 * Totals over the last `days` days: by purpose, by model and by day. `unpriced`
 * counts the calls that carry tokens but no cost, so a total is never quietly
 * short: a reader can see how much of it the dollar figure covers.
 */
export function usageSummary({ days = 30 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const agg = `COUNT(*) AS calls, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
    SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
    SUM(audio_seconds) AS audio_seconds, SUM(cost_usd) AS cost_usd,
    SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced_calls`;
  const total = db.prepare(`SELECT ${agg} FROM model_usage WHERE at >= ?`).get(since);
  const byPurpose = db.prepare(`SELECT purpose, ${agg} FROM model_usage WHERE at >= ? GROUP BY purpose ORDER BY cost_usd DESC`).all(since);
  const byModel = db.prepare(`SELECT provider, model, ${agg} FROM model_usage WHERE at >= ? GROUP BY provider, model ORDER BY cost_usd DESC`).all(since);
  const byDay = db.prepare(`SELECT substr(at, 1, 10) AS day, ${agg} FROM model_usage WHERE at >= ? GROUP BY day ORDER BY day`).all(since);
  const notes = db.prepare('SELECT COUNT(*) AS c FROM notes WHERE created_at >= ?').get(since).c;
  return { days, since, notes, total, by_purpose: byPurpose, by_model: byModel, by_day: byDay };
}

// ---- agent memory ----

export function addAgentMemory(agent, content) {
  db.prepare('INSERT INTO agent_memory (id, agent, content, created_at) VALUES (?, ?, ?, ?)')
    .run(newId(), agent, content, now());
}

export function getAgentMemory(agent, limit = 30) {
  return db.prepare('SELECT * FROM agent_memory WHERE agent = ? ORDER BY created_at DESC LIMIT ?').all(agent, limit);
}

export function stats() {
  const total = db.prepare('SELECT COUNT(*) AS c FROM notes').get().c;
  const ready = db.prepare("SELECT COUNT(*) AS c FROM notes WHERE status = 'ready'").get().c;
  const cats = db.prepare('SELECT COUNT(*) AS c FROM categories').get().c;
  return { total_notes: total, ready_notes: ready, categories: cats };
}

// Fold the WAL back into the main .db and close cleanly. Called on shutdown so
// the on-disk database is self-contained (no dependence on -wal/-shm state) —
// which is what makes a copy or backup safe to take.
let closed = false;
export function closeDb() {
  if (closed) return;
  closed = true;
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch (e) { console.error('[db] checkpoint failed:', e.message); }
  try { db.close(); } catch (e) { console.error('[db] close failed:', e.message); }
}

export default db;
