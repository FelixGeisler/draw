import AdmZip from "adm-zip";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import type express from "express";
import { freshApp, testDb } from "../helpers.js";
import {
  createBackupArchive,
  readMaterialFilesSafely,
} from "../../src/services/backupService.js";
import {
  AUTHORITY_FILE,
  PushLifecycle,
  validateAuthorityDocument,
  type PushDependency,
  type PushSnapshot,
} from "../../src/push/authority.js";

const ENDPOINT_CANARY = "https://push.invalid/ENDPOINT-CANARY-337";
const P256DH_CANARY = "P256DH-CANARY-337";
const AUTH_CANARY = "AUTH-CANARY-337";
const dataDir = () => process.env.DATA_DIR!;
const filesDir = () => path.join(dataDir(), "files");

function insertPushRow(database: Database.Database, suffix = "") {
  database
    .prepare(
      `INSERT INTO push_subscriptions
       (id, endpoint, p256dh, auth, expiration_time, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(
      `device${suffix}`,
      `${ENDPOINT_CANARY}${suffix}`,
      `${P256DH_CANARY}${suffix}`,
      `${AUTH_CANARY}${suffix}`,
      "2026-09-19T00:00:00.000Z",
      "2026-09-19T00:00:00.000Z",
    );
}

function expectNoCanaries(bytes: Buffer) {
  for (const canary of [ENDPOINT_CANARY, P256DH_CANARY, AUTH_CANARY]) {
    expect(bytes.includes(Buffer.from(canary))).toBe(false);
  }
}

let app: express.Express;
beforeAll(async () => {
  app = await freshApp();
});

describe("credential-free backup artifacts", () => {
  it("physically rewrites manual/scheduled archive DBs and excludes authority/markers", async () => {
    const database = await testDb();
    insertPushRow(database);
    database.prepare("UPDATE settings SET value = '1' WHERE key = 'push_hide_details'").run();
    fs.writeFileSync(path.join(dataDir(), "push-authority.json"), "AUTHORITY-FILE-CANARY-337");
    fs.writeFileSync(path.join(dataDir(), "push-authority-reset-pending"), "RESET-MARKER-CANARY-337");
    fs.writeFileSync(path.join(dataDir(), "push-restore-pending"), "RESTORE-MARKER-CANARY-337");
    fs.writeFileSync(path.join(filesDir(), "ordinary.txt"), "ordinary material");

    const archivePath = createBackupArchive();
    try {
      const archive = new AdmZip(archivePath);
      const names = archive.getEntries().map((entry) => entry.entryName);
      expect(names).not.toContain("push-authority.json");
      expect(names.some((name) => name.includes("pending"))).toBe(false);
      const databaseBytes = archive.getEntry("app.db")!.getData();
      expectNoCanaries(databaseBytes);
      expect(databaseBytes.includes(Buffer.from("AUTHORITY-FILE-CANARY-337"))).toBe(false);
      const extracted = path.join(dataDir(), "credential-free-export.db");
      fs.writeFileSync(extracted, databaseBytes);
      const exported = new Database(extracted, { readonly: true });
      try {
        expect(exported.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get()).toEqual({ n: 0 });
        expect(exported.prepare("SELECT value FROM settings WHERE key = 'push_hide_details'").get()).toEqual({
          value: "1",
        });
      } finally {
        exported.close();
        fs.rmSync(extracted, { force: true });
      }
    } finally {
      fs.rmSync(archivePath, { force: true });
      database.prepare("DELETE FROM push_subscriptions").run();
      for (const name of ["push-authority.json", "push-authority-reset-pending", "push-restore-pending"]) {
        fs.rmSync(path.join(dataDir(), name), { force: true });
      }
    }
  });

  it("rejects a hard-linked authority alias and publishes no archive", () => {
    const authority = path.join(dataDir(), "authority-hardlink-canary");
    const alias = path.join(filesDir(), "alias.bin");
    fs.writeFileSync(authority, "HARDLINK-AUTHORITY-CANARY-337");
    fs.linkSync(authority, alias);
    const before = new Set(fs.readdirSync(dataDir()).filter((name) => name.endsWith(".zip")));
    try {
      expect(() => createBackupArchive()).toThrow(/singly-linked regular file/);
      expect(new Set(fs.readdirSync(dataDir()).filter((name) => name.endsWith(".zip")))).toEqual(before);
    } finally {
      fs.rmSync(alias, { force: true });
      fs.rmSync(authority, { force: true });
    }
  });

  it("rejects crafted persistent schema code before it can leak credential rows", async () => {
    const database = await testDb();
    database.prepare("DELETE FROM push_subscriptions").run();
    database.prepare("DELETE FROM settings WHERE key = 'crafted_push_leak'").run();
    const cleanArchivePath = createBackupArchive();
    const zip = new AdmZip(cleanArchivePath);
    fs.rmSync(cleanArchivePath, { force: true });
    const craftedPath = path.join(dataDir(), "crafted-trigger-import.db");
    fs.writeFileSync(craftedPath, zip.getEntry("app.db")!.getData());
    const crafted = new Database(craftedPath);
    try {
      insertPushRow(crafted, "-trigger");
      crafted.exec(`CREATE TRIGGER exfiltrate_push_credentials
        BEFORE DELETE ON push_subscriptions
        BEGIN
          INSERT OR REPLACE INTO settings (key, value)
          VALUES ('crafted_push_leak', OLD.endpoint || '|' || OLD.p256dh || '|' || OLD.auth);
        END`);
    } finally {
      crafted.close();
    }
    zip.deleteFile("app.db");
    zip.addFile("app.db", fs.readFileSync(craftedPath));
    fs.rmSync(craftedPath, { force: true });
    const bakPath = path.join(dataDir(), "app.db.bak");
    fs.rmSync(bakPath, { force: true });

    await request(app)
      .post("/api/backup/import")
      .attach("file", zip.toBuffer(), "crafted-trigger.zip")
      .expect(400);

    const live = await testDb();
    expect(live.prepare("SELECT value FROM settings WHERE key = 'crafted_push_leak'").get()).toBeUndefined();
    expectNoCanaries(fs.readFileSync(path.join(dataDir(), "app.db")));
    expect(fs.existsSync(bakPath)).toBe(false);

    const subsequentExport = createBackupArchive();
    try {
      expectNoCanaries(fs.readFileSync(subsequentExport));
    } finally {
      fs.rmSync(subsequentExport, { force: true });
    }
  });

  it("sanitizes crafted imports and the app.db.bak safety copy physically", async () => {
    const database = await testDb();
    insertPushRow(database, "-old-live");
    const cleanArchivePath = createBackupArchive();
    const zip = new AdmZip(cleanArchivePath);
    fs.rmSync(cleanArchivePath, { force: true });
    const craftedPath = path.join(dataDir(), "crafted-import.db");
    fs.writeFileSync(craftedPath, zip.getEntry("app.db")!.getData());
    const crafted = new Database(craftedPath);
    insertPushRow(crafted, "-crafted");
    crafted.close();
    zip.deleteFile("app.db");
    zip.addFile("app.db", fs.readFileSync(craftedPath));
    fs.rmSync(craftedPath, { force: true });

    const response = await request(app)
      .post("/api/backup/import")
      .attach("file", zip.toBuffer(), "crafted.zip")
      .expect(200);
    expect(response.body.pushRecoveryPending).toBeUndefined();

    const restored = await testDb();
    expect(restored.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get()).toEqual({ n: 0 });
    expectNoCanaries(fs.readFileSync(path.join(dataDir(), "app.db")));
    const bakBytes = fs.readFileSync(path.join(dataDir(), "app.db.bak"));
    expectNoCanaries(bakBytes);
    const bak = new Database(path.join(dataDir(), "app.db.bak"), { readonly: true });
    try {
      expect(bak.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get()).toEqual({ n: 0 });
    } finally {
      bak.close();
    }
  });
});

describe("descriptor-bound material traversal", () => {
  function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "draw-material-race-"));
    const original = path.join(root, "material.txt");
    fs.writeFileSync(original, "ORIGINAL-DESCRIPTOR-BYTES");
    return { root, original };
  }

  it("rejects a material symlink without dereferencing it", () => {
    const { root, original } = fixture();
    const linked = path.join(root, "linked.txt");
    try {
      try {
        fs.symlinkSync(original, linked, "file");
      } catch (error) {
        // Windows without Developer Mode cannot create a test symlink; the
        // race tests below still exercise the no-follow fallback.
        if ((error as NodeJS.ErrnoException).code === "EPERM") return;
        throw error;
      }
      expect(() => readMaterialFilesSafely(root)).toThrow(/unsafe backup material link/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a nested directory swap to a symlink before traversal", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "draw-material-directory-race-"));
    const nested = path.join(root, "nested");
    const held = path.join(root, "held");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "draw-material-directory-canary-"));
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, "ordinary.txt"), "ordinary");
    fs.writeFileSync(path.join(outside, "authority-canary.txt"), "NESTED-AUTHORITY-CANARY");
    const probe = path.join(root, "symlink-probe");
    try {
      try {
        fs.symlinkSync(outside, probe, "dir");
        fs.rmSync(probe, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return;
        throw error;
      }
      expect(() =>
        readMaterialFilesSafely(root, {
          beforeDirectoryRead: (directory) => {
            if (directory !== nested) return;
            fs.renameSync(nested, held);
            fs.symlinkSync(outside, nested, "dir");
          },
        }),
      ).toThrow(/directory changed before traversal|unsafe backup material directory/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a nested directory swap to an empty replacement instead of silently omitting it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "draw-material-directory-race-"));
    const nested = path.join(root, "nested");
    const held = path.join(root, "held");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, "authority-canary.txt"), "NESTED-AUTHORITY-CANARY");
    try {
      expect(() =>
        readMaterialFilesSafely(root, {
          beforeDirectoryRead: (directory) => {
            if (directory !== nested) return;
            fs.renameSync(nested, held);
            fs.mkdirSync(nested);
          },
        }),
      ).toThrow(/directory changed before traversal/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a path swap before open", () => {
    const { root, original } = fixture();
    const held = path.join(root, "held.txt");
    try {
      expect(() =>
        readMaterialFilesSafely(root, {
          beforeOpen: (file) => {
            if (file !== original) return;
            fs.renameSync(original, held);
            fs.writeFileSync(original, "REPLACEMENT-CANARY");
          },
        }),
      ).toThrow(/changed before read/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads only the original verified descriptor, then rejects an after-open path swap", () => {
    const { root, original } = fixture();
    const held = path.join(root, "held.txt");
    let descriptorBytes = "";
    try {
      expect(() =>
        readMaterialFilesSafely(root, {
          afterOpen: (file) => {
            if (file !== original) return;
            fs.renameSync(original, held);
            fs.writeFileSync(original, "AFTER-OPEN-REPLACEMENT-CANARY");
          },
          beforePostcheck: (_file, fd) => {
            const probe = Buffer.alloc(64);
            const count = fs.readSync(fd, probe, 0, probe.length, 0);
            descriptorBytes = probe.subarray(0, count).toString("utf8");
          },
        }),
      ).toThrow(/changed during read/);
      expect(descriptorBytes).toBe("ORIGINAL-DESCRIPTOR-BYTES");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

class PendingPush implements PushDependency {
  begun = 0;
  completed = 0;
  aborted = 0;
  failFinalization = true;
  snapshot(): PushSnapshot {
    return { available: true, reason: null, publicVapidKey: "fake", generation: "fake" };
  }
  generation() { return "fake"; }
  invalidate() {}
  reset() {}
  beginRestore() { this.begun += 1; }
  completeRestore() {
    this.completed += 1;
    if (this.failFinalization) throw new Error("synthetic post-commit finalization failure");
  }
  abortRestore() { this.aborted += 1; }
}

describe("restore response contract", () => {
  it("aborts Push restore and returns the existing non-2xx response on a caught pre-commit failure", async () => {
    const archivePath = createBackupArchive();
    const bytes = fs.readFileSync(archivePath);
    fs.rmSync(archivePath, { force: true });
    const push = new PendingPush();
    push.failFinalization = false;
    const guardedApp = await freshApp({ push });
    const squatter = new Database(path.join(dataDir(), "app.db"));
    try {
      squatter.pragma("journal_mode = WAL");
      squatter.prepare("SELECT COUNT(*) FROM tasks").get();
      await request(guardedApp)
        .post("/api/backup/import")
        .attach("file", bytes, "backup.zip")
        .expect(409);
    } finally {
      squatter.close();
    }
    expect(push.begun).toBe(1);
    expect(push.aborted).toBe(1);
    expect(push.completed).toBe(0);
  });

  it("returns committed 200 + exact pending flag when Push finalization fails", async () => {
    const archivePath = createBackupArchive();
    const bytes = fs.readFileSync(archivePath);
    fs.rmSync(archivePath, { force: true });
    const push = new PendingPush();
    const pendingApp = await freshApp({ push });
    const response = await request(pendingApp)
      .post("/api/backup/import")
      .attach("file", bytes, "backup.zip")
      .expect(200);
    expect(response.body).toMatchObject({ pushRecoveryPending: true });
    expect(push.begun).toBe(1);
    expect(push.completed).toBe(1);
    expect(push.aborted).toBe(0);
  });

  it("a committed restore may replace malformed old authority only under its durable marker", async () => {
    const archivePath = createBackupArchive();
    const bytes = fs.readFileSync(archivePath);
    fs.rmSync(archivePath, { force: true });
    const authorityPath = path.join(dataDir(), AUTHORITY_FILE);
    fs.writeFileSync(authorityPath, '{"malformed":"OLD-AUTHORITY-CANARY"}');
    const lifecycle = new PushLifecycle({
      dataDir: dataDir(),
      deleteSubscriptions: () => {
        const database = new Database(path.join(dataDir(), "app.db"));
        try {
          database.prepare("DELETE FROM push_subscriptions").run();
        } finally {
          database.close();
        }
      },
    });
    expect(lifecycle.snapshot().reason).toBe("authority-unavailable");
    const restoreApp = await freshApp({ push: lifecycle });
    const response = await request(restoreApp)
      .post("/api/backup/import")
      .attach("file", bytes, "backup.zip")
      .expect(200);
    expect(response.body.pushRecoveryPending).toBeUndefined();
    expect(lifecycle.snapshot().available).toBe(true);
    expect(() =>
      validateAuthorityDocument(JSON.parse(fs.readFileSync(authorityPath, "utf8")) as unknown),
    ).not.toThrow();
  });
});
