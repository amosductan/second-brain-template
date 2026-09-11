/**
 * Prove the backups are restorable: the local copies, and the off-site copy
 * when BACKUP_OFFSITE_DIR is set.
 *
 * backup_db.mjs already verifies each snapshot at CREATION time. This checks
 * them where they now LIVE, which is a different question: a synced folder can
 * open a file mid-write or evict it to the cloud, and a disk can rot. A backup
 * nobody has ever opened is a hope, not a backup.
 *
 * Read-only and non-destructive: it never writes to a snapshot and never touches
 * the live DB. Safe to run any time, including while the server is up.
 *
 * Run: node scripts/verify_backups.mjs [--count 3] [--quiet]
 * Exit 0 = every checked snapshot is restorable; 1 = at least one is not.
 * Schedule it after the backup and alert on a non-zero exit.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
// Paths come from config, never from a default of this script's own, so this
// verifies the directory backup_db.mjs actually wrote to. Two scripts resolving
// the same path independently is how a healthy backup gets reported missing.
import { config } from '../server/config.js';

const LOCATIONS = [
  { label: 'local', dir: path.join(config.dataDir, 'backups') },
  ...(config.backupOffsiteDir ? [{ label: 'off-site', dir: config.backupOffsiteDir }] : []),
];

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const countIdx = args.indexOf('--count');
const COUNT = countIdx >= 0 ? Number(args[countIdx + 1]) : 3;

function say(line) { if (!quiet) console.log(line); }

/** Open a snapshot read-only and ask SQLite whether it is intact. */
function checkSnapshot(file) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const integrity = db.prepare('PRAGMA integrity_check').get();
    const verdict = Object.values(integrity)[0];
    if (verdict !== 'ok') return { ok: false, why: `integrity_check: ${verdict}` };
    // A structurally valid but empty/tableless file is still a failed backup.
    const notes = db.prepare('SELECT count(*) AS n FROM notes').get().n;
    if (!Number.isInteger(notes)) return { ok: false, why: 'could not count notes' };
    return { ok: true, notes };
  } catch (err) {
    return { ok: false, why: err.message };
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

const failures = [];
let checked = 0;

for (const { label, dir } of LOCATIONS) {
  if (!fs.existsSync(dir)) {
    failures.push(`${label}: directory missing (${dir})`);
    say(`${label.padEnd(9)} MISSING DIRECTORY ${dir}`);
    continue;
  }
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.db'))
    .sort()
    .reverse()
    .slice(0, COUNT);

  if (files.length === 0) {
    failures.push(`${label}: no snapshots found`);
    say(`${label.padEnd(9)} NO SNAPSHOTS in ${dir}`);
    continue;
  }

  for (const f of files) {
    const full = path.join(dir, f);
    const size = fs.statSync(full).size;
    const r = checkSnapshot(full);
    checked++;
    if (r.ok) {
      say(`${label.padEnd(9)} OK    ${f}  ${r.notes} notes, ${(size / 1024).toFixed(0)}KB`);
    } else {
      failures.push(`${label}/${f}: ${r.why}`);
      say(`${label.padEnd(9)} FAIL  ${f}  ${r.why}`);
    }
  }
}

say(`\nchecked ${checked} snapshot(s), ${failures.length} failure(s)`);

if (failures.length > 0) {
  // Printed even with --quiet: a silently broken backup is invisible until the
  // day it's needed, and then it's too late.
  console.error(`BACKUP VERIFICATION FAILED (${failures.length}):\n${failures.join('\n')}`);
  process.exitCode = 1;
}
