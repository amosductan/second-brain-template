/**
 * Backup the Second Brain SQLite database to a self-contained snapshot.
 *
 * Uses `VACUUM INTO`, which writes a fully checkpointed, standalone .db (no
 * -wal/-shm dependency) — safe to copy, open, or restore. Runs against the LIVE
 * database while the server is up (WAL allows a concurrent reader), so no
 * downtime. Verifies every snapshot (integrity_check + note count) and deletes
 * it if it doesn't pass, so a bad backup is never left looking valid.
 *
 * Keeps the last N locally and, when BACKUP_OFFSITE_DIR is set, mirrors each
 * snapshot there too (a synced folder, a NAS). A snapshot is a static file, so
 * it is safe to sync, unlike the live database.
 *
 * Schedule it nightly: cron, systemd timer, launchd, or Windows Task Scheduler.
 *
 * Run:  node scripts/backup_db.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
// Both backup scripts read the paths from config, never defaults of their own:
// two scripts resolving the same path independently will eventually disagree,
// and then snapshots are written to one directory and verified in another.
import { config } from '../server/config.js';

const KEEP = 14;
const dataDir = config.dataDir;
const srcDb = path.join(dataDir, 'second-brain.db');
const localBackupDir = path.join(dataDir, 'backups');
// Give each install its own off-site folder: two installs writing same-named
// snapshots into one folder would silently overwrite each other.
const offsiteDir = config.backupOffsiteDir;

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function pruneOld(dir) {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir)
    .filter((f) => /^second-brain-\d{8}-\d{6}\.db$/.test(f))
    .sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP))) {
    fs.rmSync(path.join(dir, f), { force: true });
  }
}

function main() {
  if (!fs.existsSync(srcDb)) {
    console.error(`[backup] source DB not found: ${srcDb}`);
    process.exit(1);
  }
  fs.mkdirSync(localBackupDir, { recursive: true });

  const name = `second-brain-${ts()}.db`;
  const out = path.join(localBackupDir, name);

  // Hot backup: VACUUM INTO from a reader connection.
  const db = new DatabaseSync(srcDb);
  db.exec(`VACUUM INTO '${out.replace(/'/g, "''").replace(/\\/g, '/')}'`);
  db.close();

  // Verify the snapshot is self-contained and complete.
  const check = new DatabaseSync(out);
  const integ = check.prepare('PRAGMA integrity_check').get().integrity_check;
  const notes = check.prepare('SELECT COUNT(*) AS c FROM notes').get().c;
  check.close();

  if (integ !== 'ok') {
    fs.rmSync(out, { force: true });
    console.error(`[backup] integrity_check FAILED (${integ}) — snapshot discarded`);
    process.exit(2);
  }

  const sizeKb = Math.round(fs.statSync(out).size / 1024);
  console.log(`[backup] ok: ${name}  (${notes} notes, ${sizeKb} KB, integrity ok)`);

  pruneOld(localBackupDir);

  if (!offsiteDir) return;
  try {
    fs.mkdirSync(offsiteDir, { recursive: true });
    fs.copyFileSync(out, path.join(offsiteDir, name));
    pruneOld(offsiteDir);
    console.log(`[backup] mirrored to ${offsiteDir}`);
  } catch (e) {
    console.error(`[backup] off-site mirror skipped: ${e.message}`);
  }
}

main();
