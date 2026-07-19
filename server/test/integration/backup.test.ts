import { beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import AdmZip from "adm-zip";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type express from "express";
import { freshApp, testDb } from "../helpers.js";
import { CURRENT_VERSION } from "../../src/db.js";
import { createBackupArchive, MANIFEST_APP } from "../../src/services/backupService.js";

// Backup export/import (#61, ADR-26). User-data-critical: the round trip
// must reproduce EVERYTHING, including a material file on disk, and every
// rejected import must leave the live data untouched. Tests in this file are
// order-dependent (they share one DATA_DIR and deliberately replace it).

let app: express.Express;
const dataDir = () => process.env.DATA_DIR!;
const filesDir = () => path.join(dataDir(), "files");

// Binary payload (not valid UTF-8) so "identical" means byte-for-byte, not
// merely same-when-decoded.
const FILE_CONTENT = Buffer.concat([
  Buffer.from("lecture content: ANOVA\n"),
  Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80]),
]);

const binaryParser = (
  res: NodeJS.ReadableStream & { on: (ev: string, fn: (c?: Buffer) => void) => void },
  cb: (err: Error | null, body: Buffer) => void,
) => {
  const chunks: Buffer[] = [];
  res.on("data", (c?: Buffer) => {
    if (c) chunks.push(c);
  });
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

async function exportArchive(): Promise<{ body: Buffer; disposition: string }> {
  const res = await request(app)
    .get("/api/backup/export")
    .buffer(true)
    .parse(binaryParser as never)
    .expect(200);
  return { body: res.body as Buffer, disposition: res.headers["content-disposition"] };
}

async function importArchive(archive: Buffer) {
  return request(app).post("/api/backup/import").attach("file", archive, "backup.zip");
}

/** Full API snapshot used to prove "identical" and "untouched". */
async function apiSnapshot() {
  const [tasks, goals, settings, gamification] = await Promise.all([
    request(app).get("/api/tasks").expect(200),
    request(app).get("/api/goals").expect(200),
    request(app).get("/api/settings").expect(200),
    // Derived from completions + rest setting + freeze earn log (ADR-28) —
    // equality here proves the streak inputs made the round trip.
    request(app).get("/api/gamification").expect(200),
  ]);
  return {
    tasks: tasks.body,
    goals: goals.body,
    settings: settings.body,
    gamification: gamification.body,
  };
}

let goalId: number;
let taskId: number;
let materialId: number;

beforeAll(async () => {
  app = await freshApp();

  // Seed: a goal with a real uploaded file, a linked task, a completion
  // (gamification history), a changed setting, and a stored API key.
  const goal = (
    await request(app).post("/api/goals").send({ title: "Backup goal", outcome: "restored intact" }).expect(201)
  ).body;
  goalId = goal.id;

  const material = (
    await request(app)
      .post(`/api/goals/${goalId}/materials`)
      .attach("file", FILE_CONTENT, { filename: "lecture.txt", contentType: "text/plain" })
      .expect(201)
  ).body;
  materialId = material.id;

  const task = (
    await request(app)
      .post("/api/tasks")
      .send({ title: "Backup keepsake", categoryId: 1, goalId, impact: 4, effortMinutes: 15 })
      .expect(201)
  ).body;
  taskId = task.id;

  const done = (
    await request(app)
      .post("/api/tasks")
      .send({ title: "Already done", categoryId: 2, effortMinutes: 5 })
      .expect(201)
  ).body;
  await request(app).patch(`/api/tasks/${done.id}`).send({ status: "done" }).expect(200);

  await request(app).patch("/api/settings").send({ max_draw_effort: 45 }).expect(200);
  await request(app).patch("/api/settings").send({ streak_rest_weekdays: [6, 0] }).expect(200);
  await request(app).put("/api/ai/key").send({ key: "sk-ant-backup-test-000" }).expect(200);

  // Streak/freeze state (#58, ADR-28) must survive the round trip too. One
  // earned token is banked directly — earning organically needs a 7-day
  // streak — using the same localtime day convention completeTask writes.
  const db = await testDb();
  db.prepare(
    "INSERT INTO streak_freezes (milestone_day, created_at) VALUES (date('now', 'localtime'), ?)",
  ).run(new Date().toISOString());
});

describe("GET /api/backup/export", () => {
  it("streams one zip — DB snapshot, manifest, material files — named draw-backup-YYYY-MM-DD.zip", async () => {
    const { body, disposition } = await exportArchive();
    expect(disposition).toMatch(/attachment; filename="draw-backup-\d{4}-\d{2}-\d{2}\.zip"/);

    const zip = new AdmZip(body);
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names).toContain("app.db");
    expect(names).toContain("manifest.json");
    const fileEntries = names.filter((n) => n.startsWith("files/") && !n.endsWith("/"));
    expect(fileEntries).toHaveLength(1);
    expect(zip.getEntry(fileEntries[0])!.getData().equals(FILE_CONTENT)).toBe(true);

    const manifest = JSON.parse(zip.getEntry("manifest.json")!.getData().toString("utf-8"));
    expect(manifest.app).toBe(MANIFEST_APP);
    expect(manifest.userVersion).toBe(CURRENT_VERSION);
    expect(manifest.counts).toEqual({ tasks: 2, goals: 1, materials: 1 });
  });

  it("is correct mid-WAL: a commit made moments before export is in the snapshot (VACUUM INTO, no raw copy)", async () => {
    // This write sits in app.db-wal (nowhere near the 1000-page autocheckpoint),
    // so a naive fs.copyFile of app.db would lose it.
    const probe = (
      await request(app)
        .post("/api/tasks")
        .send({ title: "Mid-WAL probe", categoryId: 1, effortMinutes: 5 })
        .expect(201)
    ).body;

    const { body } = await exportArchive();
    const extracted = path.join(dataDir(), "extract-probe.db");
    fs.writeFileSync(extracted, new AdmZip(body).getEntry("app.db")!.getData());
    const snapshot = new Database(extracted, { readonly: true, fileMustExist: true });
    try {
      expect(snapshot.prepare("SELECT title FROM tasks WHERE id = ?").get(probe.id)).toEqual({
        title: "Mid-WAL probe",
      });
    } finally {
      snapshot.close();
      fs.rmSync(extracted, { force: true });
    }
    await request(app).delete(`/api/tasks/${probe.id}`).expect(200);
  });

  it("strips the API key from the exported DB only — the live DB keeps it", async () => {
    const { body } = await exportArchive();
    const extracted = path.join(dataDir(), "extract-key.db");
    fs.writeFileSync(extracted, new AdmZip(body).getEntry("app.db")!.getData());
    const snapshot = new Database(extracted, { readonly: true, fileMustExist: true });
    try {
      expect(
        snapshot.prepare("SELECT value FROM settings WHERE key = 'anthropic_api_key'").get(),
      ).toBeUndefined();
      // Other settings survive the strip.
      expect(
        snapshot.prepare("SELECT value FROM settings WHERE key = 'max_draw_effort'").get(),
      ).toEqual({ value: "45" });
    } finally {
      snapshot.close();
      fs.rmSync(extracted, { force: true });
    }

    const db = await testDb();
    expect(db.prepare("SELECT value FROM settings WHERE key = 'anthropic_api_key'").get()).toEqual({
      value: "sk-ant-backup-test-000",
    });
    expect((await request(app).get("/api/ai/status")).body.configured).toBe(true);
  });
});

describe("POST /api/backup/import — round trip", () => {
  it("export → wipe → import restores all data, including the material file byte-for-byte", async () => {
    const before = await apiSnapshot();
    expect(before.tasks.length).toBeGreaterThan(0);
    const { body: archive } = await exportArchive();

    // Wipe: every row of every table, and the files directory's contents.
    const db = await testDb();
    db.exec(
      `DELETE FROM completions; DELETE FROM time_entries; DELETE FROM card_art;
       DELETE FROM materials; DELETE FROM tasks; DELETE FROM achievements;
       DELETE FROM goals; DELETE FROM settings; DELETE FROM streak_freezes;`,
    );
    for (const f of fs.readdirSync(filesDir())) {
      fs.rmSync(path.join(filesDir(), f), { recursive: true, force: true });
    }
    expect((await request(app).get("/api/tasks")).body).toEqual([]);
    await request(app).get(`/api/materials/${materialId}/download`).expect(404);

    const res = await importArchive(archive);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tasks: 2, goals: 1, materials: 1 });

    // All data identical (the API key was never in the archive, so ai-status
    // flips to unconfigured — asserted separately below).
    const after = await apiSnapshot();
    expect(after.tasks).toEqual(before.tasks);
    expect(after.goals).toEqual(before.goals);
    expect(after.settings).toEqual(before.settings);
    expect(after.gamification).toEqual(before.gamification);
    // The banked token itself, not just the derived number (#58, ADR-28) —
    // testDb() is re-fetched because the import swapped and reopened `db`.
    expect(after.gamification.freezesBanked).toBe(1);
    const restored = await testDb();
    expect(restored.prepare("SELECT COUNT(*) AS n FROM streak_freezes").get()).toEqual({ n: 1 });

    const download = await request(app)
      .get(`/api/materials/${materialId}/download`)
      .buffer(true)
      .parse(binaryParser as never)
      .expect(200);
    expect((download.body as Buffer).equals(FILE_CONTENT)).toBe(true);
  });

  it("the restored DB has no API key: backups never carry it", async () => {
    expect((await request(app).get("/api/ai/status")).body.configured).toBe(false);
  });

  it("keeps the previous database as app.db.bak (here: the wiped state)", async () => {
    const bakPath = path.join(dataDir(), "app.db.bak");
    expect(fs.existsSync(bakPath)).toBe(true);
    const bak = new Database(bakPath, { readonly: true, fileMustExist: true });
    try {
      // The pre-import live DB was the wiped one — zero rows everywhere.
      expect(bak.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 0 });
      expect(bak.prepare("SELECT COUNT(*) AS n FROM goals").get()).toEqual({ n: 0 });
    } finally {
      bak.close();
    }
  });

  it("keeps the previous material files as files.bak", async () => {
    expect(fs.existsSync(path.join(dataDir(), "files.bak"))).toBe(true);
  });
});

describe("POST /api/backup/import — rejections (live data untouched)", () => {
  async function expectRejected(archive: Buffer, messagePattern: RegExp) {
    const before = await apiSnapshot();
    const res = await importArchive(archive);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(messagePattern);
    expect(await apiSnapshot()).toEqual(before);
    // The material file also survived.
    await request(app).get(`/api/materials/${materialId}/download`).expect(200);
  }

  it("rejects garbage bytes that are not a zip", async () => {
    await expectRejected(Buffer.from("definitely not a zip archive"), /not a readable zip/);
  });

  it("rejects a zip without our manifest", async () => {
    const zip = new AdmZip();
    zip.addFile("readme.txt", Buffer.from("just some zip"));
    await expectRejected(zip.toBuffer(), /manifest\.json is missing/);
  });

  it("rejects a manifest from another app", async () => {
    const zip = new AdmZip();
    zip.addFile("manifest.json", Buffer.from(JSON.stringify({ app: "other-tool", userVersion: 1 })));
    await expectRejected(zip.toBuffer(), /not exported by this app/);
  });

  it("rejects an archive whose app.db is not a SQLite database", async () => {
    const zip = new AdmZip();
    zip.addFile(
      "manifest.json",
      Buffer.from(JSON.stringify({ app: MANIFEST_APP, userVersion: CURRENT_VERSION })),
    );
    zip.addFile("app.db", Buffer.from("not a database"));
    await expectRejected(zip.toBuffer(), /not a SQLite database/);
  });

  it("rejects a corrupt database (integrity_check)", async () => {
    // Export a REAL backup, then corrupt the cell pointer array of the DB's
    // last page (a table leaf) — a torn page with an intact header, exactly
    // what a bad copy or truncated disk write produces.
    const { body: good } = await exportArchive();
    const zip = new AdmZip(good);
    const bytes = zip.getEntry("app.db")!.getData();
    const pageSize = bytes.readUInt16BE(16); // SQLite header: page size at offset 16
    // Smash the page header + cell pointer area of every page after page 1:
    // whatever btree pages hold the actual rows, their structure is now torn
    // while the file header (magic, page size, user_version) stays intact.
    for (let page = pageSize; page < bytes.length; page += pageSize) {
      bytes.fill(0xa5, page + 8, page + 148);
    }

    const corrupt = new AdmZip();
    corrupt.addFile(
      "manifest.json",
      Buffer.from(JSON.stringify({ app: MANIFEST_APP, userVersion: CURRENT_VERSION })),
    );
    corrupt.addFile("app.db", bytes);
    await expectRejected(corrupt.toBuffer(), /corrupt|not a SQLite database/);
  });

  it("rejects a valid SQLite file that is not a draw database (forged user_version)", async () => {
    const foreignPath = path.join(dataDir(), "foreign-probe.db");
    const foreign = new Database(foreignPath);
    foreign.exec("CREATE TABLE something_else (x TEXT)");
    foreign.pragma(`user_version = ${CURRENT_VERSION}`);
    foreign.close();
    const bytes = fs.readFileSync(foreignPath);
    fs.rmSync(foreignPath, { force: true });

    const zip = new AdmZip();
    zip.addFile(
      "manifest.json",
      Buffer.from(JSON.stringify({ app: MANIFEST_APP, userVersion: CURRENT_VERSION })),
    );
    zip.addFile("app.db", bytes);
    await expectRejected(zip.toBuffer(), /missing required tables/);
  });

  it("rejects a backup made by a newer app version (user_version ahead of the server)", async () => {
    const newerPath = path.join(dataDir(), "newer-probe.db");
    const newer = new Database(newerPath);
    newer.exec("CREATE TABLE future (x TEXT)");
    newer.pragma(`user_version = ${CURRENT_VERSION + 1}`);
    newer.close();
    const bytes = fs.readFileSync(newerPath);
    fs.rmSync(newerPath, { force: true });

    const zip = new AdmZip();
    zip.addFile(
      "manifest.json",
      Buffer.from(JSON.stringify({ app: MANIFEST_APP, userVersion: CURRENT_VERSION + 1 })),
    );
    zip.addFile("app.db", bytes);
    await expectRejected(zip.toBuffer(), /newer version/);
  });

  it("rejects an archive with a zip-slip file entry before anything is swapped", async () => {
    // adm-zip normalizes ".." when WRITING entries, so a hostile archive is
    // forged by binary-patching the entry name (same length keeps all zip
    // offsets valid) — reading preserves the raw name, as the importer does.
    const { body: good } = await exportArchive();
    const zip = new AdmZip(good);
    zip.addFile("files/zz/escape.txt", Buffer.from("outside the sandbox"));
    const patched = zip.toBuffer();
    const needle = Buffer.from("files/zz/escape.txt");
    const evil = Buffer.from("files/../escape.txt");
    let idx = patched.indexOf(needle);
    while (idx !== -1) {
      evil.copy(patched, idx);
      idx = patched.indexOf(needle, idx + 1);
    }
    // The forgery worked: the archive really carries a traversal entry name.
    expect(new AdmZip(patched).getEntries().map((e) => e.entryName)).toContain(
      "files/../escape.txt",
    );

    await expectRejected(patched, /unsafe file path/);
    expect(fs.existsSync(path.join(dataDir(), "escape.txt"))).toBe(false);
  });

  it("rejects a missing multipart file field", async () => {
    const res = await request(app).post("/api/backup/import").expect(400);
    expect(res.body.error).toMatch(/backup file is required/);
  });
});

describe("POST /api/backup/import — older-schema backup is migrated forward", () => {
  it("imports a v2-era backup and migrates it to the current user_version", async () => {
    // Reconstruct the v2 schema the same way migration.test.ts does: today's
    // schema.sql minus the columns/tables later migrations added.
    const schemaPath = fileURLToPath(new URL("../../src/schema.sql", import.meta.url));
    const current = fs.readFileSync(schemaPath, "utf-8");
    const v2Schema = current
      // v15 (#157): strip the sort_order column + stamp trigger FIRST, so
      // window_end regains its trailing newline before the window strip below
      // (the forward-migration on import re-adds both).
      .replace(/,\r?\n  -- Stored sibling position[\s\S]*?sort_order REAL NOT NULL DEFAULT 0/, "")
      .replace(/-- Stamp sort_order[\s\S]*?END;\r?\n/, "")
      .replace(/last_drawn_at TEXT,[\s\S]*?window_end TEXT\r?\n/, "last_drawn_at TEXT\n")
      .replace(/-- AI card art cache[\s\S]*?CREATE TABLE card_art[\s\S]*?\);\r?\n/, "")
      .replace(/-- Streak freeze tokens[\s\S]*?CREATE TABLE streak_freezes[\s\S]*?\);\r?\n/, "")
      .replace(/,\r?\n  -- Warm-up draw[\s\S]*?was_warmup INTEGER NOT NULL DEFAULT 0/, "")
      .replace(/,\r?\n  \('warmup_every_hours', '8'\)/, "")
      // v11 (#92): a genuine v2 backup has no anthropic_file_id column, so the
      // forward-migration on import re-adds it. Leaving it in would make the
      // import's ALTER fail with a duplicate column (a raw 500).
      .replace(/  -- Anthropic Files API id[\s\S]*?anthropic_file_id TEXT,\r?\n/, "")
      // v14 (#156): a genuine v2 backup has no draws table and no achievements
      // claim columns, so the forward-migration on import re-adds them. Leaving
      // them in would make the import's CREATE TABLE / ALTER fail (a raw 500).
      .replace(/-- Draw log[\s\S]*?CREATE TABLE draws[\s\S]*?\);\r?\n/, "")
      .replace(/,\r?\n  -- Claim-for-XP[\s\S]*?claim_xp INTEGER/, "");
    expect(v2Schema).not.toContain("deferred_until");
    expect(v2Schema).not.toContain("card_art");
    expect(v2Schema).not.toContain("streak_freezes");
    expect(v2Schema).not.toContain("was_warmup");
    expect(v2Schema).not.toContain("warmup_every_hours");
    expect(v2Schema).not.toContain("anthropic_file_id");
    expect(v2Schema).not.toContain("CREATE TABLE draws");
    expect(v2Schema).not.toContain("claim_xp");
    expect(v2Schema).not.toContain("sort_order");

    const legacyDbPath = path.join(dataDir(), "legacy-backup.db");
    const legacy = new Database(legacyDbPath);
    legacy.exec(v2Schema);
    const legacyGoal = legacy
      .prepare("INSERT INTO goals (title, created_at) VALUES (?, ?)")
      .run("Legacy goal", new Date().toISOString());
    legacy
      .prepare(
        "INSERT INTO tasks (title, category_id, goal_id, effort_minutes, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("Legacy task", 1, legacyGoal.lastInsertRowid, 10, new Date().toISOString());
    legacy
      .prepare(
        `INSERT INTO materials (goal_id, kind, filename, stored_name, mime_type, size_bytes, created_at)
         VALUES (?, 'file', 'legacy.txt', 'legacy-stored.txt', 'text/plain', ?, ?)`,
      )
      .run(legacyGoal.lastInsertRowid, FILE_CONTENT.length, new Date().toISOString());
    legacy.pragma("user_version = 2");
    legacy.close();
    const legacyBytes = fs.readFileSync(legacyDbPath);
    fs.rmSync(legacyDbPath, { force: true });

    const zip = new AdmZip();
    zip.addFile("manifest.json", Buffer.from(JSON.stringify({ app: MANIFEST_APP, userVersion: 2 })));
    zip.addFile("app.db", legacyBytes);
    zip.addFile("files/legacy-stored.txt", FILE_CONTENT);

    // The live DB still holds the round-trip data — after this import it must
    // sit in app.db.bak (pre-import data, per the acceptance criteria).
    const res = await importArchive(zip.toBuffer());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tasks: 1, goals: 1, materials: 1 });

    // Migrated forward: current version, migration defaults live on the API.
    const db = await testDb();
    expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_VERSION);
    const tasks = (await request(app).get("/api/tasks").expect(200)).body;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      title: "Legacy task",
      blocked: false,
      deferredUntil: null,
      subtaskOrderMode: "parallel",
      windowDays: null,
    });

    // The legacy material file landed on disk and serves byte-for-byte.
    const materials = (await request(app).get(`/api/goals/${tasks[0].goalId}/materials`).expect(200))
      .body;
    const download = await request(app)
      .get(`/api/materials/${materials[0].id}/download`)
      .buffer(true)
      .parse(binaryParser as never)
      .expect(200);
    expect((download.body as Buffer).equals(FILE_CONTENT)).toBe(true);

    // app.db.bak now holds the pre-import (round-trip) data.
    const bak = new Database(path.join(dataDir(), "app.db.bak"), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(bak.prepare("SELECT title FROM tasks WHERE id = ?").get(taskId)).toEqual({
        title: "Backup keepsake",
      });
    } finally {
      bak.close();
    }
  });
});

// Issue #103: the temp artifacts around export/import. All three items share a
// theme — the happy path was fine, the interrupted/contended paths were not.
// Last describe in the file: these tests create and destroy their own
// artifacts, and the boot sweep would otherwise run under the earlier ones.
describe("temp-artifact hygiene (#103)", () => {
  const orphans = () =>
    fs
      .readdirSync(dataDir())
      .filter((n) => n.startsWith("backup-export-") || n.startsWith("backup-import-"));

  it("two exports in the same millisecond both succeed", async () => {
    // The stem was `Date.now()` alone, so a same-millisecond pair collided on
    // one path — and `VACUUM INTO` refuses an existing file, so the second
    // export died as a raw 500. Freezing the clock makes that deterministic
    // instead of a race nobody can reproduce on demand.
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    let first: string;
    let second: string;
    try {
      first = createBackupArchive();
      second = createBackupArchive();
    } finally {
      now.mockRestore();
    }
    expect(second).not.toBe(first);
    expect(fs.existsSync(first)).toBe(true);
    expect(fs.existsSync(second)).toBe(true);
    // Both are real archives, not one truncated over the other.
    for (const zipPath of [first, second]) {
      expect(new AdmZip(zipPath).getEntries().map((e) => e.entryName)).toContain("app.db");
      fs.rmSync(zipPath, { force: true });
    }
  });

  it("sweeps crash-orphaned temp artifacts at boot, keeping real state and the uploads dir", async () => {
    const uploads = path.join(dataDir(), "backup-uploads");
    fs.mkdirSync(uploads, { recursive: true });
    // Exactly what a `kill -9` mid-export/-import/-upload leaves behind.
    fs.writeFileSync(path.join(uploads, "a1b2c3d4"), "half-received upload");
    fs.writeFileSync(path.join(dataDir(), "backup-export-1700000000000-1.zip"), "orphan zip");
    fs.writeFileSync(path.join(dataDir(), "backup-export-1700000000000-1.db"), "orphan snapshot");
    fs.writeFileSync(path.join(dataDir(), "backup-import-1700000000000-1.db"), "orphan staged db");
    fs.mkdirSync(path.join(dataDir(), "backup-import-files-1700000000000-1"), { recursive: true });
    expect(orphans()).toHaveLength(4);

    await freshApp(); // the boot path — createApp() sweeps before serving

    expect(orphans()).toEqual([]);
    expect(fs.readdirSync(uploads)).toEqual([]);
    // Emptied, never removed: multer creates this once at module load, so
    // deleting it would ENOENT the next import instead of cleaning anything.
    expect(fs.existsSync(uploads)).toBe(true);
    // Real state is not "temp" and must survive — including the swap's own
    // safety copies, which look adjacent but are the user's last resort.
    expect(fs.existsSync(path.join(dataDir(), "app.db"))).toBe(true);
    expect(fs.existsSync(filesDir())).toBe(true);
    expect(fs.existsSync(path.join(dataDir(), "app.db.bak"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir(), "files.bak"))).toBe(true);
    // Still serving from the swept directory.
    await request(app).get("/api/tasks").expect(200);
  });

  it("aborts the swap when another connection still holds the database open", async () => {
    const archive = (await exportArchive()).body;
    const before = await apiSnapshot();

    // SQLite deletes -wal/-shm when the LAST connection closes, so a second
    // one surviving our close() is the tell. This is the single-process
    // assumption ADR-26 used to take on faith: without the check the import
    // deletes a WAL this connection is still writing into, then swaps a
    // different file underneath it.
    const squatter = new Database(path.join(dataDir(), "app.db"));
    let res;
    try {
      squatter.pragma("journal_mode = WAL");
      squatter.prepare("SELECT COUNT(*) AS n FROM tasks").get();
      res = await importArchive(archive);
    } finally {
      squatter.close();
    }

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/another process still has the database open/);
    // Aborted BEFORE the first destructive step: nothing moved, and the live
    // handle was reopened, so the app is still serving.
    expect(await apiSnapshot()).toEqual(before);
  });

  it("…and the very same archive imports fine once the other connection is gone", async () => {
    // Proves the 409 above was the squatter, not a broken archive — and that
    // the abort left the import path fully working.
    const archive = (await exportArchive()).body;
    const res = await importArchive(archive);
    expect(res.status).toBe(200);
  });
});
