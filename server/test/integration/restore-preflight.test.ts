import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import AdmZip from "adm-zip";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type express from "express";
import { freshApp, testDb } from "../helpers.js";
import { historicalSchema } from "../historicalRestoreSchemas.js";
import { CURRENT_VERSION } from "../../src/db.js";
import { MANIFEST_APP, createBackupArchive } from "../../src/services/backupService.js";

let app: express.Express;
const dataDir = () => process.env.DATA_DIR!;

beforeAll(async () => {
  app = await freshApp();
});

function archiveForDatabase(databaseBytes: Buffer, version: number): Buffer {
  const zip = new AdmZip();
  zip.addFile("manifest.json", Buffer.from(JSON.stringify({ app: MANIFEST_APP, userVersion: version })));
  zip.addFile("app.db", databaseBytes);
  return zip.toBuffer();
}

function historicalArchive(version: number): Buffer {
  const databasePath = path.join(dataDir(), `historical-v${version}.db`);
  const database = new Database(databasePath);
  try {
    database.exec(historicalSchema(version));
    database.pragma(`user_version = ${version}`);
  } finally {
    database.close();
  }
  const bytes = fs.readFileSync(databasePath);
  fs.rmSync(databasePath, { force: true });
  return archiveForDatabase(bytes, version);
}

function mutateCurrentArchive(name: string, mutate: (database: Database.Database) => void): Buffer {
  const cleanPath = createBackupArchive();
  const zip = new AdmZip(cleanPath);
  fs.rmSync(cleanPath, { force: true });
  const databasePath = path.join(dataDir(), `preflight-${name}.db`);
  fs.writeFileSync(databasePath, zip.getEntry("app.db")!.getData());
  const database = new Database(databasePath);
  try {
    mutate(database);
  } finally {
    database.close();
  }
  zip.deleteFile("app.db");
  zip.addFile("app.db", fs.readFileSync(databasePath));
  fs.rmSync(databasePath, { force: true });
  return zip.toBuffer();
}

describe("bounded staged restore schema preflight", () => {
  it("admits real fresh v1 and every checked-in historical boundary through v23", async () => {
    for (let version = 1; version <= CURRENT_VERSION; version += 1) {
      const response = await request(app)
        .post("/api/backup/import")
        .attach("file", historicalArchive(version), `historical-v${version}.zip`);
      expect(response.status, `schema v${version}: ${JSON.stringify(response.body)}`).toBe(200);
      expect(response.body).toEqual({ tasks: 0, goals: 0, materials: 0 });
      const database = await testDb();
      expect(database.pragma("user_version", { simple: true })).toBe(CURRENT_VERSION);
      database.close();
    }
  }, 30_000);

  it("rederives stale, missing, and moved v23 logical projection rows after exact schema admission", async () => {
    const task = (await request(app).post("/api/tasks").send({ title: "restore projection", categoryId: 1 }).expect(201)).body;
    await request(app).post(`/api/tasks/${task.id}/timer/start`).expect(200);
    const cases: Array<[string, (database: Database.Database) => void]> = [
      ["missing-derived", (database) => database.prepare("DELETE FROM week_interval_access").run()],
      ["stale-derived", (database) => database.prepare("UPDATE week_interval_access SET start_ms=start_ms+1").run()],
      ["moved-rtree", (database) => database.prepare("UPDATE week_interval_rtree SET start_day=start_day+1,end_day=end_day+1").run()],
    ];
    for (const [name, mutate] of cases) {
      const response = await request(app)
        .post("/api/backup/import")
        .attach("file", mutateCurrentArchive(name, mutate), `${name}.zip`);
      expect(response.status, `${name}: ${JSON.stringify(response.body)}`).toBe(200);
      const database = await testDb();
      const source = database.prepare("SELECT started_at AS startedAt FROM time_entries WHERE task_id=?").get(task.id) as { startedAt: string };
      const derived = database.prepare(
        "SELECT start_ms AS startMs FROM week_interval_access WHERE source_kind=2 AND task_id=?",
      ).get(task.id) as { startMs: number };
      expect(derived.startMs, name).toBe(Date.parse(source.startedAt));
      expect(database.prepare(`SELECT COUNT(*) AS n FROM week_interval_access a
        JOIN week_interval_rtree r ON r.index_id=a.index_id
        WHERE a.start_day=r.start_day AND a.end_day=r.end_day`).get()).toEqual(
        database.prepare("SELECT COUNT(*) AS n FROM week_interval_access").get(),
      );
      database.close();
    }
  });

  it("rejects unknown executable, virtual, shadow-like and altered known inventory without swapping live data", async () => {
    await request(app).post("/api/tasks").send({ title: "preflight live canary", categoryId: 1 }).expect(201);
    const cases: Array<[string, (database: Database.Database) => void]> = [
      ["view", (database) => database.exec("CREATE VIEW unknown_view AS SELECT title FROM tasks")],
      ["trigger", (database) => database.exec(
        "CREATE TRIGGER unknown_trigger AFTER INSERT ON tasks BEGIN DELETE FROM settings; END",
      )],
      ["virtual", (database) => database.exec("CREATE VIRTUAL TABLE unknown_rtree USING rtree(id,min,max)")],
      ["deceptive-shadow", (database) => {
        database.exec("DROP TABLE week_interval_rtree");
        database.exec("CREATE TABLE week_interval_rtree_node(nodeno INTEGER PRIMARY KEY,data)");
      }],
      ["missing-trigger", (database) => database.exec("DROP TRIGGER tasks_stamp_sort_order")],
      ["missing-week-trigger", (database) => database.exec("DROP TRIGGER week_time_entries_ai_dirty")],
      ["altered-week-trigger", (database) => {
        database.exec("DROP TRIGGER week_time_entries_ai_dirty");
        database.exec(`CREATE TRIGGER week_time_entries_ai_dirty AFTER INSERT ON time_entries
          BEGIN UPDATE week_access_state SET ready=0 WHERE singleton=1; END`);
      }],
      ["mismatched-rtree", (database) => {
        database.exec("DROP TABLE week_interval_rtree");
        database.exec("CREATE VIRTUAL TABLE week_interval_rtree USING rtree(index_id,start_day,end_day)");
      }],
      ["extra-shadow", (database) => database.exec("CREATE TABLE week_interval_rtree_extra_node(id INTEGER)")],
      ["oversized-known-trigger", (database) => {
        database.exec("DROP TRIGGER tasks_stamp_sort_order");
        database.exec(`CREATE TRIGGER tasks_stamp_sort_order AFTER INSERT ON tasks
          WHEN NEW.sort_order = 0 BEGIN
            ${"/* bounded-preflight */".repeat(500)}
            UPDATE tasks SET sort_order=1 WHERE id=NEW.id;
          END`);
      }],
    ];

    for (const [name, mutate] of cases) {
      const response = await request(app)
        .post("/api/backup/import")
        .attach("file", mutateCurrentArchive(name, mutate), `${name}.zip`);
      expect(response.status, name).toBe(400);
      expect(response.body.error).toMatch(/bounded schema preflight/);
      const tasks = (await request(app).get("/api/tasks?status=all").expect(200)).body;
      expect(tasks.some((task: { title: string }) => task.title === "preflight live canary"), name).toBe(true);
    }
  });
});
