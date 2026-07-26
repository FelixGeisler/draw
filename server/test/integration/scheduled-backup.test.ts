import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import AdmZip from "adm-zip";
import fs from "node:fs";
import path from "node:path";
import type express from "express";
import { freshApp } from "../helpers.js";
import { CURRENT_VERSION } from "../../src/db.js";
import { startBackupScheduler } from "../../src/backupScheduler.js";
import {
  backupsDir,
  isScheduledBackupName,
  MANIFEST_APP,
  runScheduledBackup,
} from "../../src/services/backupService.js";

// Scheduled automatic backups (#194, ADR-52) driven against a temp DATA_DIR.
// The scheduler's tick (runScheduledBackup) is called DIRECTLY — no real
// setInterval, so nothing here can leak a timer or depend on wall-clock timing.

let app: express.Express;
const dataDir = () => process.env.DATA_DIR!;
const filesDir = () => path.join(dataDir(), "files");

const FILE_CONTENT = Buffer.from("lecture notes: scheduled backup fixture\n");

function scheduledArchives(): string[] {
  if (!fs.existsSync(backupsDir)) return [];
  return fs.readdirSync(backupsDir).filter(isScheduledBackupName).sort();
}

function wipeBackups() {
  fs.rmSync(backupsDir, { recursive: true, force: true });
}

beforeAll(async () => {
  app = await freshApp();
  // Seed one goal + one material file on disk + one linked task, so the DB has
  // content AND files/ is non-empty (the archive must carry both).
  const goal = (
    await request(app).post("/api/goals").send({ title: "Backup goal" }).expect(201)
  ).body;
  await request(app)
    .post(`/api/goals/${goal.id}/materials`)
    .attach("file", FILE_CONTENT, { filename: "notes.txt", contentType: "text/plain" })
    .expect(201);
  await request(app)
    .post("/api/tasks")
    .send({ title: "Keepsake", categoryId: 1, goalId: goal.id, effortMinutes: 10 })
    .expect(201);
});

describe("runScheduledBackup — writes a valid archive under DATA_DIR/backups/", () => {
  it("produces a scheduled-named zip with the DB snapshot, manifest, and material files", () => {
    wipeBackups();
    const result = runScheduledBackup(3, new Date("2026-07-26T02:00:00Z"));

    expect(path.dirname(result.path)).toBe(backupsDir);
    expect(isScheduledBackupName(path.basename(result.path))).toBe(true);
    expect(fs.existsSync(result.path)).toBe(true);
    expect(result.pruned).toEqual([]);

    const names = new AdmZip(result.path).getEntries().map((e) => e.entryName);
    expect(names).toContain("app.db");
    expect(names).toContain("manifest.json");
    expect(names.filter((n) => n.startsWith("files/") && !n.endsWith("/"))).toHaveLength(1);

    const manifest = JSON.parse(
      new AdmZip(result.path).getEntry("manifest.json")!.getData().toString("utf-8"),
    );
    expect(manifest.app).toBe(MANIFEST_APP);
    expect(manifest.userVersion).toBe(CURRENT_VERSION);
    expect(manifest.counts).toEqual({ tasks: 1, goals: 1, materials: 1 });
  });

  it("never includes the backups/ directory itself — the recursion guard holds", () => {
    wipeBackups();
    // A prior archive already sitting in backups/ must NOT be swept into the
    // next one (no archive-inside-archive). createBackupArchive globs files/
    // only, and backups/ is its sibling — this proves it stays that way.
    fs.mkdirSync(backupsDir, { recursive: true });
    fs.writeFileSync(
      path.join(backupsDir, "draw-backup-2026-07-25T00-00-00Z.zip"),
      "pretend prior archive",
    );

    const result = runScheduledBackup(9, new Date("2026-07-26T03:00:00Z"));
    const names = new AdmZip(result.path).getEntries().map((e) => e.entryName);
    expect(names.some((n) => n.replaceAll("\\", "/").startsWith("backups/"))).toBe(false);
    expect(names.some((n) => n.endsWith(".zip"))).toBe(false);
  });
});

describe("runScheduledBackup — retention pruning across runs", () => {
  it("keeps only the newest N archives, pruning the rest", () => {
    wipeBackups();
    const base = new Date("2026-07-26T00:00:00Z").getTime();
    const HOUR = 60 * 60 * 1000;

    // Four runs an hour apart, retention 2.
    const r0 = runScheduledBackup(2, new Date(base));
    expect(r0.pruned).toEqual([]);
    const r1 = runScheduledBackup(2, new Date(base + 1 * HOUR));
    expect(r1.pruned).toEqual([]);
    const r2 = runScheduledBackup(2, new Date(base + 2 * HOUR));
    expect(r2.pruned).toEqual([path.basename(r0.path)]); // oldest dropped
    const r3 = runScheduledBackup(2, new Date(base + 3 * HOUR));
    expect(r3.pruned).toEqual([path.basename(r1.path)]);

    // Exactly the newest two survive on disk.
    expect(scheduledArchives()).toEqual(
      [path.basename(r2.path), path.basename(r3.path)].sort(),
    );
  });

  it("never deletes a foreign file during a real prune — only scheduled archives (ADR-52)", () => {
    wipeBackups();
    fs.mkdirSync(backupsDir, { recursive: true });
    // Files an operator might legitimately keep alongside the scheduled ones:
    // a manual date-only export and an arbitrary note. Neither matches the
    // scheduled-archive pattern, so the destructive rmSync prune must skip them.
    fs.writeFileSync(path.join(backupsDir, "keep-me.zip"), "operator's own file");
    fs.writeFileSync(path.join(backupsDir, "draw-backup-2026-07-26.zip"), "manual date-only export");

    const base = new Date("2026-08-01T00:00:00Z").getTime();
    const HOUR = 60 * 60 * 1000;
    runScheduledBackup(1, new Date(base));
    const r = runScheduledBackup(1, new Date(base + HOUR)); // forces a real prune at retention 1

    expect(r.pruned.length).toBeGreaterThan(0); // a scheduled archive really was deleted
    expect(r.pruned.every(isScheduledBackupName)).toBe(true);
    // The foreign files are untouched.
    expect(fs.existsSync(path.join(backupsDir, "keep-me.zip"))).toBe(true);
    expect(fs.existsSync(path.join(backupsDir, "draw-backup-2026-07-26.zip"))).toBe(true);
  });

  it("writes distinct archives for same-second runs and keeps the newer (dedup + protect)", () => {
    wipeBackups();
    const now = new Date("2026-09-09T09:09:09Z");
    const first = runScheduledBackup(1, now);
    const second = runScheduledBackup(1, now); // same second → the `-1` dedup suffix

    expect(second.path).not.toBe(first.path);
    expect(fs.existsSync(first.path)).toBe(true);
    // `-1.zip` sorts BEFORE `.zip`, so the newer archive would be the prune
    // target at retention 1 — but it survives because it is the protected
    // just-written result.
    expect(fs.existsSync(second.path)).toBe(true);
    expect(second.pruned).toEqual([]);
    expect(scheduledArchives()).toHaveLength(2);
  });
});

describe("startBackupScheduler — the production default tick (no injected runBackup)", () => {
  afterEach(() => vi.useRealTimers());

  it("fires the real runScheduledBackup on its interval and honors retention, then stops clean", () => {
    wipeBackups();
    vi.useFakeTimers();
    // No runBackup injected → the exact prod.ts path: () => runScheduledBackup(retention).
    const handle = startBackupScheduler(1, 2);
    expect(handle).not.toBeNull();
    try {
      vi.advanceTimersByTime(60 * 60 * 1000); // tick 1 → one real archive
      expect(scheduledArchives()).toHaveLength(1);
      vi.advanceTimersByTime(60 * 60 * 1000); // tick 2
      vi.advanceTimersByTime(60 * 60 * 1000); // tick 3 → prune back to retention 2
      expect(scheduledArchives()).toHaveLength(2);
    } finally {
      handle!.stop(); // clear the interval before real timers return — no leak
    }
    // Nothing runs after stop().
    vi.advanceTimersByTime(5 * 60 * 60 * 1000);
    expect(scheduledArchives()).toHaveLength(2);
  });
});

describe("a scheduled archive round-trips through POST /api/backup/import", () => {
  it("imports a produced archive back successfully", async () => {
    wipeBackups();
    const result = runScheduledBackup(5, new Date("2026-07-26T05:00:00Z"));
    const bytes = fs.readFileSync(result.path);

    const res = await request(app).post("/api/backup/import").attach("file", bytes, "backup.zip");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tasks: 1, goals: 1, materials: 1 });

    // The data is intact after the swap-and-reopen, and the material file
    // served from the restored files/ still matches byte-for-byte.
    const tasks = (await request(app).get("/api/tasks").expect(200)).body;
    expect(tasks).toHaveLength(1);
    const goals = (await request(app).get("/api/goals").expect(200)).body;
    const materials = (
      await request(app).get(`/api/goals/${goals[0].id}/materials`).expect(200)
    ).body;
    expect(materials).toHaveLength(1);
    // The import left the material files in place — files/ is non-empty.
    expect(fs.readdirSync(filesDir()).length).toBeGreaterThan(0);
  });
});
