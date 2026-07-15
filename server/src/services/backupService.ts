import AdmZip from "adm-zip";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import {
  API_KEY_SETTING,
  CURRENT_VERSION,
  dataDir,
  db,
  dbPath,
  filesDir,
  reopenDatabase,
} from "../db.js";

// Backup archive layout (#61, ADR-26): one zip holding a `VACUUM INTO`
// snapshot of the database, every material file, and a manifest that lets
// import reject foreign zips before touching anything.
export const MANIFEST_APP = "draw-task-planner";
const MANIFEST_ENTRY = "manifest.json";
const DB_ENTRY = "app.db";
const FILES_PREFIX = "files/";

export interface BackupManifest {
  app: string;
  exportedAt: string;
  userVersion: number;
  counts: ImportSummary;
}

export interface ImportSummary {
  tasks: number;
  goals: number;
  materials: number;
}

/** Thrown for every rejected import — the live data is untouched when it fires. */
export class BackupError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Pure manifest builder — kept separate so validateManifest can be unit-tested against it. */
export function buildManifest(userVersion: number, counts: ImportSummary, exportedAt: string): BackupManifest {
  return { app: MANIFEST_APP, exportedAt, userVersion, counts };
}

/** Returns a human-readable problem, or null when the parsed manifest is one of ours. */
export function validateManifest(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return "manifest.json is not an object";
  }
  const m = raw as Record<string, unknown>;
  if (m.app !== MANIFEST_APP) return "the archive was not exported by this app";
  if (!Number.isInteger(m.userVersion) || (m.userVersion as number) < 1) {
    return "manifest userVersion is missing or invalid";
  }
  return null;
}

/**
 * Map a `files/...` zip entry to its extraction target, or null when the
 * entry would escape the staging directory (zip-slip: `files/../evil`,
 * backslash variants, absolute or drive-qualified paths). Backslashes are
 * treated as separators on EVERY platform — a zip is foreign input, and an
 * entry that is hostile on Windows must not pass validation on Linux either.
 */
export function fileEntryTarget(entryName: string, stagingDir: string): string | null {
  const relative = entryName.slice(FILES_PREFIX.length).replaceAll("\\", "/");
  if (!relative || relative.startsWith("/") || relative.includes(":")) return null;
  const segments = relative.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  const root = path.resolve(stagingDir);
  const target = path.resolve(root, ...segments);
  // Belt and braces — the segment checks above already guarantee this.
  if (target === root || !target.startsWith(root + path.sep)) return null;
  return target;
}

function countRows(handle: Database.Database): ImportSummary {
  const count = (table: string) =>
    (handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { tasks: count("tasks"), goals: count("goals"), materials: count("materials") };
}

/**
 * Build the backup zip and return its path (inside DATA_DIR — the caller
 * streams and deletes it). The DB snapshot is taken with `VACUUM INTO`: the
 * only safe way to copy a live WAL database — recent commits live in
 * `app.db-wal`, so copying `app.db` itself would silently drop them.
 */
export function createBackupArchive(): string {
  const stamp = Date.now();
  const snapshotPath = path.join(dataDir, `backup-export-${stamp}.db`);
  const zipPath = path.join(dataDir, `backup-export-${stamp}.zip`);
  db.prepare("VACUUM INTO ?").run(snapshotPath);
  try {
    // Privacy (ADR-11): backups get copied around, so the plaintext API key
    // is deleted from the SNAPSHOT only — the live database keeps it.
    const snapshot = new Database(snapshotPath);
    let manifest: BackupManifest;
    try {
      snapshot.prepare("DELETE FROM settings WHERE key = ?").run(API_KEY_SETTING);
      manifest = buildManifest(
        snapshot.pragma("user_version", { simple: true }) as number,
        countRows(snapshot),
        new Date().toISOString(),
      );
    } finally {
      snapshot.close();
    }

    const zip = new AdmZip();
    zip.addLocalFile(snapshotPath, "", DB_ENTRY);
    zip.addFile(MANIFEST_ENTRY, Buffer.from(JSON.stringify(manifest, null, 2)));
    for (const name of fs.readdirSync(filesDir)) {
      const full = path.join(filesDir, name);
      if (fs.statSync(full).isFile()) zip.addLocalFile(full, FILES_PREFIX.slice(0, -1));
    }
    zip.writeZip(zipPath);
    return zipPath;
  } finally {
    fs.rmSync(snapshotPath, { force: true });
  }
}

export function exportFilename(now: Date): string {
  return `draw-backup-${now.toISOString().slice(0, 10)}.zip`;
}

/**
 * Replace ALL data with the archive's contents. Two phases:
 *  1. Stage + validate — extract into temp paths inside DATA_DIR and reject
 *     anything suspect with a 400 BackupError; nothing live is touched.
 *  2. Swap — restart-safe ordering (see swapIn) with the `app.db` rename as
 *     the atomic commit point, then reopen and migrate forward.
 */
export function importBackupArchive(zipPath: string): ImportSummary {
  const stamp = Date.now();
  const stagedDbPath = path.join(dataDir, `backup-import-${stamp}.db`);
  const stagedFilesDir = path.join(dataDir, `backup-import-files-${stamp}`);
  try {
    stageAndValidate(zipPath, stagedDbPath, stagedFilesDir);
    swapIn(stagedDbPath, stagedFilesDir);
    return countRows(db);
  } finally {
    fs.rmSync(stagedDbPath, { force: true });
    fs.rmSync(stagedFilesDir, { recursive: true, force: true });
  }
}

function stageAndValidate(zipPath: string, stagedDbPath: string, stagedFilesDir: string) {
  let entries: AdmZip.IZipEntry[];
  try {
    entries = new AdmZip(zipPath).getEntries();
  } catch {
    throw new BackupError(400, "not a readable zip archive");
  }

  const manifestEntry = entries.find((e) => e.entryName === MANIFEST_ENTRY);
  if (!manifestEntry) {
    throw new BackupError(400, "not a draw backup: manifest.json is missing from the archive");
  }
  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(manifestEntry.getData().toString("utf-8"));
  } catch {
    throw new BackupError(400, "not a draw backup: manifest.json is not valid JSON");
  }
  const manifestProblem = validateManifest(manifestRaw);
  if (manifestProblem) throw new BackupError(400, `not a draw backup: ${manifestProblem}`);

  const dbEntry = entries.find((e) => e.entryName === DB_ENTRY);
  if (!dbEntry) throw new BackupError(400, "not a draw backup: app.db is missing from the archive");
  fs.writeFileSync(stagedDbPath, dbEntry.getData());

  // The staged database must prove itself BEFORE anything live moves. The
  // version gate reads the real pragma, not the manifest: `user_version` up
  // to CURRENT_VERSION is accepted and migrated forward on reopen; anything
  // newer would be silently misread by this build's SQL.
  const staged = new Database(stagedDbPath, { fileMustExist: true });
  try {
    let integrity: unknown;
    let version: number;
    try {
      integrity = staged.pragma("integrity_check", { simple: true });
      version = staged.pragma("user_version", { simple: true }) as number;
    } catch {
      throw new BackupError(400, "the archive's app.db is not a SQLite database");
    }
    if (integrity !== "ok") {
      throw new BackupError(400, "the backup database is corrupt (integrity_check failed)");
    }
    if (version < 1) {
      throw new BackupError(400, "the backup database carries no schema version");
    }
    if (version > CURRENT_VERSION) {
      throw new BackupError(
        400,
        `this backup was made by a newer version of the app (schema v${version}, this server supports up to v${CURRENT_VERSION}) — update the app, then restore`,
      );
    }
    // A forged user_version on an arbitrary SQLite file would pass the checks
    // above, swap in, and 500 every request until the user digs out app.db.bak.
    // Require the v1 core tables (present in every schema version) up front.
    const REQUIRED_TABLES = [
      "categories",
      "goals",
      "tasks",
      "time_entries",
      "completions",
      "materials",
      "achievements",
      "settings",
    ];
    const hasTable = staged.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    );
    const missing = REQUIRED_TABLES.filter((t) => !hasTable.get(t));
    if (missing.length > 0) {
      throw new BackupError(
        400,
        `the backup database is missing required tables: ${missing.join(", ")}`,
      );
    }
  } finally {
    staged.close();
  }

  fs.mkdirSync(stagedFilesDir, { recursive: true });
  for (const entry of entries) {
    if (entry.isDirectory || !entry.entryName.startsWith(FILES_PREFIX)) continue;
    const target = fileEntryTarget(entry.entryName, stagedFilesDir);
    if (!target) throw new BackupError(400, `unsafe file path in archive: ${entry.entryName}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.getData());
  }
}

/**
 * Restart-safe swap. Invariant: a crash at ANY step leaves a boot that finds
 * either the complete old state or the complete new state — never a torn DB.
 *
 *  - checkpoint(TRUNCATE) + close, then delete `-wal`/`-shm`: a stale WAL
 *    would otherwise be replayed into the RESTORED database on reopen — the
 *    torn-DB hazard this ordering exists to prevent. After the checkpoint the
 *    WAL holds nothing, so deleting it loses nothing.
 *  - `app.db` is COPIED to `app.db.bak` (not renamed): the live path never
 *    disappears, so a crash before the final rename still boots the complete
 *    old database instead of auto-creating a fresh empty one.
 *  - files/ swaps first, the `app.db` rename goes LAST: it replaces the file
 *    in a single same-volume rename — the atomic commit point. Before it: old
 *    state (files recoverable from files.bak). After it: new state.
 */
function swapIn(stagedDbPath: string, stagedFilesDir: string) {
  const bakPath = `${dbPath}.bak`;
  const filesBakDir = path.join(dataDir, "files.bak");
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  try {
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
    fs.copyFileSync(dbPath, bakPath);

    fs.rmSync(filesBakDir, { recursive: true, force: true });
    if (fs.existsSync(filesDir)) fs.renameSync(filesDir, filesBakDir);
    try {
      fs.renameSync(stagedFilesDir, filesDir);
      fs.renameSync(stagedDbPath, dbPath); // commit point
    } catch (e) {
      // Roll the files swap back so the old state stays complete.
      fs.rmSync(filesDir, { recursive: true, force: true });
      if (fs.existsSync(filesBakDir)) fs.renameSync(filesBakDir, filesDir);
      throw e;
    }
  } finally {
    // Reopens whichever app.db is now in place (new on success, old on a
    // failed swap) and runs migrate(), so older backups move forward to
    // CURRENT_VERSION exactly like an old database would on boot.
    reopenDatabase();
  }
}
