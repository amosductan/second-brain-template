/**
 * Prune old Second Brain audio while keeping every transcript.
 *
 * Audio is the only thing here that grows without bound (~8 MB a note, 244 MB
 * after a few weeks). The transcript is the durable asset; the recording is a
 * source file you almost never replay after a few months.
 *
 * Policy, in order of confidence:
 *   1. Orphans — files in DATA_DIR/audio that no note row references. Always
 *      deleted; nothing can ever use them again.
 *   2. Aged audio of `ready` notes older than AUDIO_RETENTION_DAYS (default 180).
 *      The file goes, the note and transcript stay, and audio_pruned_at is
 *      stamped so the UI can say "audio pruned" instead of showing a dead player.
 *
 * Never touches audio for a note that isn't `ready` — that audio is still needed
 * to transcribe or to retry.
 *
 * Run:  node scripts/prune_audio.mjs [--dry-run] [--days N] [--verbose]
 * Schedule it weekly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { audioDir, uploadDir, config } from '../server/config.js';
import { referencedAudioPaths, prunableAudioNotes, markAudioPruned } from '../server/db.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');
const daysArg = args.indexOf('--days');
const RETENTION_DAYS = daysArg !== -1 && args[daysArg + 1]
  ? Number(args[daysArg + 1])
  : Number(process.env.AUDIO_RETENTION_DAYS || 180);

if (!Number.isFinite(RETENTION_DAYS) || RETENTION_DAYS < 1) {
  console.error(`[prune] refusing to run with retention "${RETENTION_DAYS}" — must be >= 1 day`);
  process.exit(2);
}

const STAGING_MAX_HOURS = Number(process.env.STAGING_MAX_HOURS || 24);

const logDir = path.join(config.dataDir, 'logs');
const logFile = path.join(logDir, 'prune.log');

function log(line) {
  const stamped = `[${new Date().toISOString()}]${dryRun ? ' DRY-RUN' : ''} ${line}`;
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(logFile, stamped + '\n');
  console.log(stamped);
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
const ageDays = (iso) => Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);

function sizeOf(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function main() {
  if (!fs.existsSync(audioDir)) {
    log(`no audio directory at ${audioDir} - nothing to do`);
    return;
  }

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();
  log(`start: audioDir=${audioDir} retention=${RETENTION_DAYS}d cutoff=${cutoff}`);

  let reclaimed = 0;
  let deleted = 0;

  // ---- 1. orphans ----
  // Compare resolved paths: the DB stores whatever multer produced, which may
  // differ from a naive join by separator or casing.
  const referenced = new Set(
    referencedAudioPaths().map((p) => path.resolve(p).toLowerCase())
  );
  const onDisk = fs.readdirSync(audioDir).filter((f) => fs.statSync(path.join(audioDir, f)).isFile());

  const orphans = onDisk.filter((name) => !referenced.has(path.resolve(path.join(audioDir, name)).toLowerCase()));

  // Sanity gate. "Almost everything is an orphan" is never true in practice — it
  // means the DB's audio_path values point somewhere else (what moving DATA_DIR
  // without rewriting the paths leaves behind: files here, paths pointing away).
  // Deleting on that reading would destroy every recording. Bail instead.
  const orphanShare = onDisk.length ? orphans.length / onDisk.length : 0;
  if (orphans.length > 5 && orphanShare > 0.5 && !args.includes('--force')) {
    log(`ABORT: ${orphans.length}/${onDisk.length} files look orphaned (${Math.round(orphanShare * 100)}%). ` +
        'That almost always means note.audio_path points at a different directory, not that the audio is junk. ' +
        'Check that DATA_DIR and the audio paths in the database agree  (pass --force here only if the orphans are genuinely junk)');
    process.exitCode = 2;
    return;
  }

  for (const name of orphans) {
    const full = path.join(audioDir, name);
    // A completed upload may have been published after the initial DB snapshot.
    // Uploads reserve their DB path before moving here, so rechecking protects it.
    if (referencedAudioPaths().some((p) => path.resolve(p).toLowerCase() === path.resolve(full).toLowerCase())) continue;
    const bytes = sizeOf(full);
    log(`orphan: ${name} (${mb(bytes)}) - no note references it`);
    if (!dryRun) fs.rmSync(full, { force: true });
    reclaimed += bytes;
    deleted++;
  }

  // ---- 2. aged audio of ready notes ----
  const candidates = prunableAudioNotes(cutoff);
  if (verbose) log(`${candidates.length} ready note(s) with audio older than the cutoff`);

  for (const note of candidates) {
    const bytes = sizeOf(note.audio_path);
    const label = note.audio_original_name || path.basename(note.audio_path);
    log(`prune: note ${note.id} "${(note.title || 'untitled').slice(0, 60)}" ` +
        `${label} (${mb(bytes)}, ${ageDays(note.created_at)}d old) - transcript kept`);
    if (!dryRun) {
      fs.rmSync(note.audio_path, { force: true });
      markAudioPruned(note.id); // only after the file is actually gone
    }
    reclaimed += bytes;
    deleted++;
  }

  // ---- 3. abandoned staging files ----
  // Uploads are written to DATA_DIR/uploads and moved into audio/ once a note
  // row reserves them. A server killed mid-upload leaves the partial file there,
  // and nothing else ever removes it. A file still being written keeps a fresh
  // mtime, so only ones untouched for STAGING_MAX_HOURS go — and never one a
  // note still claims by name (the server finishes that move on its next boot).
  const stagingCutoff = Date.now() - STAGING_MAX_HOURS * 3600000;
  const claimedNames = new Set(referencedAudioPaths().map((p) => path.basename(p).toLowerCase()));
  const staged = fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir) : [];
  for (const name of staged) {
    const full = path.join(uploadDir, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile() || st.mtimeMs > stagingCutoff || claimedNames.has(name.toLowerCase())) continue;
    log(`stale upload: ${name} (${mb(st.size)}) - staged ${Math.floor((Date.now() - st.mtimeMs) / 3600000)}h ago, never completed`);
    if (!dryRun) fs.rmSync(full, { force: true });
    reclaimed += st.size;
    deleted++;
  }

  const remaining = fs.existsSync(audioDir)
    ? fs.readdirSync(audioDir).reduce((sum, f) => sum + sizeOf(path.join(audioDir, f)), 0)
    : 0;
  const verb = dryRun ? 'would be removed' : 'removed';
  log(`done: ${deleted} file(s) ${verb}, ${mb(reclaimed)} reclaimed; ${mb(remaining)} of audio remains`);
}

main();
