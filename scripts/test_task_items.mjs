/**
 * Guards the task_items <- action_items reconciliation.
 *
 * The whole value of task state is that it survives. syncTaskItems runs on
 * every boot and on every categorizer write, so the failure that matters is a
 * silent one: a re-categorization that quietly resets a finished item back to
 * open, or duplicates it, or drops it. Each of those looks like nothing at all
 * until someone redoes work they already did.
 *
 * Runs against an isolated DATA_DIR so the live database is never touched.
 * Usage: node scripts/test_task_items.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-tasks-'));
process.env.DATA_DIR = tmp;

const db = await import('../server/db.js');
const {
  insertNote, updateNote, deleteNote, syncTaskItems, listTasks, updateTask, taskStats,
} = db;

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
  }
}

const note = insertNote({ source: 'text', transcript: 'seed' });
const texts = (rows) => rows.filter((r) => r.note_id === note.id).map((r) => `${r.state}:${r.text}`).sort();
const all = () => listTasks({ states: ['open', 'working', 'done', 'dropped'], limit: 1000 });

console.log('1. action_items create task rows');
updateNote(note.id, { action_items: ['alpha', 'beta', 'gamma'] });
check('three open rows', texts(all()), ['open:alpha', 'open:beta', 'open:gamma']);

console.log('2. re-sync with identical items is a no-op (no duplicates)');
syncTaskItems(note.id, ['alpha', 'beta', 'gamma']);
check('still three rows', texts(all()), ['open:alpha', 'open:beta', 'open:gamma']);

console.log('3. state survives a re-sync');
const beta = all().find((r) => r.text === 'beta');
updateTask(beta.id, { state: 'done', note: 'shipped' });
syncTaskItems(note.id, ['alpha', 'beta', 'gamma']);
check('beta still done', texts(all()), ['done:beta', 'open:alpha', 'open:gamma']);

console.log('4. REORDERING does not hand a finished state to another item');
// The index-keyed version of this table fails right here: beta moves from slot
// 1 to slot 0 and 'done' lands on whatever took its place.
syncTaskItems(note.id, ['beta', 'gamma', 'alpha']);
check('beta alone is done', texts(all()), ['done:beta', 'open:alpha', 'open:gamma']);
check('display order followed the list', all().filter((r) => r.note_id === note.id)
  .sort((a, b) => a.idx - b.idx).map((r) => r.text), ['beta', 'gamma', 'alpha']);

console.log('5. an item the categorizer drops is swept only while untouched');
syncTaskItems(note.id, ['beta', 'gamma']);          // 'alpha' removed, was open
check('open alpha swept', texts(all()), ['done:beta', 'open:gamma']);
syncTaskItems(note.id, ['gamma']);                   // 'beta' removed, but done
check('done beta kept', texts(all()), ['done:beta', 'open:gamma']);

console.log('6. a re-worded item arrives open, not carrying old state');
syncTaskItems(note.id, ['gamma', 'delta']);
check('delta is new and open', texts(all()), ['done:beta', 'open:delta', 'open:gamma']);

console.log('7. blank and duplicate action items are ignored');
syncTaskItems(note.id, ['gamma', '', '   ', 'delta', 'delta']);
check('no blank or duplicate rows', texts(all()), ['done:beta', 'open:delta', 'open:gamma']);

console.log('8. invalid state is refused');
const g = all().find((r) => r.text === 'gamma');
let threw = false;
try { updateTask(g.id, { state: 'nope' }); } catch { threw = true; }
check('updateTask rejected it', threw, true);

console.log('9. category filter and state filter');
check('open-only excludes done', listTasks({ states: ['open'], limit: 100 })
  .filter((r) => r.note_id === note.id).length, 2);
check('category miss returns nothing', listTasks({ states: ['open'], category: 'No Such Category' }), []);

console.log('10. deleting a note cascades its tasks away');
const before = taskStats();
deleteNote(note.id);
check('no rows left for the note', texts(all()), []);
check('three rows went with it', taskStats().open + taskStats().done, before.open + before.done - 3);

db.closeDb();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
