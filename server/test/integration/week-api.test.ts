import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { createApp } from "../../src/app.js";
import {
  decodeWeekCursor,
  readWeekPage,
  reopenDatabase,
  shutdownWeekProjection,
} from "../../src/db.js";
import { buildWeekProjection } from "../../src/schemaV23.js";
import { disabledPushDependency } from "../../src/push/authority.js";
import { BackupError, createBackupArchive, importBackupArchive } from "../../src/services/backupService.js";
import { resolveWeek } from "../../src/weekTime.js";
import { testDb } from "../helpers.js";

const app = createApp();

async function nativeWrite(write: (database: Awaited<ReturnType<typeof testDb>>) => void) {
  const database = await testDb();
  try {
    write(database);
  } finally {
    database.close();
  }
}

async function makeProjectionReady() {
  await nativeWrite((database) => {
    database.transaction(() => {
      buildWeekProjection(database);
      database.prepare(
        "UPDATE week_access_state SET built_generation=source_generation,ready=1 WHERE singleton=1",
      ).run();
    })();
  });
}

afterAll(async () => {
  await shutdownWeekProjection();
});

describe("GET /api/calendar/week request boundary", () => {
  it("gives ADR-50 authentication precedence", async () => {
    const protectedApp = createApp({ password: "week-secret" });
    await request(protectedApp)
      .get("/api/calendar/week?unknown=%")
      .set("Content-Length", "0")
      .expect(401);
  });

  it("accepts only the exact bodyless GET shape and emits no-store JSON", async () => {
    const good = await request(app)
      .get("/api/calendar/week?weekStart=2026-10-26&timezone=Europe%2FBerlin")
      .expect(200)
      .expect("Cache-Control", "no-store")
      .expect("Content-Type", /json/);
    expect(good.body).toEqual({
      weekStart: "2026-10-26",
      timezone: "Europe/Berlin",
      requestNow: expect.stringMatching(/^\d{4}-/),
      records: [],
      nextCursor: null,
    });

    for (const target of [
      "/api/calendar/week?weekStart=2026-10-27&timezone=UTC",
      "/api/calendar/week?weekStart=2026-10-26&timezone=UTC&timezone=UTC",
      "/api/calendar/week?weekStart=2026-10-26&timezone=UTC&unknown=1",
      "/api/calendar/week?weekStart=2026-10-26&timezone=utc",
      "/api/calendar/week?weekStart=2026-10-26&timezone=US%2FEastern",
      "/api/calendar/week?weekStart=2026-10-26&timezone=Etc%2FGMT%2B1",
      "/api/calendar/week?weekStart=2026-10-26&timezone=%2B01%3A00",
      "/api/calendar/week?weekStart=2026-10-26&timezone=CET",
      "/api/calendar/week?weekStart=2026-10-26&timezone=%20UTC",
      "/api/calendar/week?weekStart=2026-10-26&timezone=UTC%20",
      "/api/calendar/week?weekStart=2026-10-26&timezone=%C3%89urope%2FBerlin",
      `/api/calendar/week?weekStart=2026-10-26&timezone=A%2F${"z".repeat(129)}`,
      "/api/calendar/week?weekStart=9999-12-27&timezone=UTC",
    ]) {
      await request(app).get(target).expect(400, { error: "invalid-week-request" });
    }
    await request(app)
      .get("/api/calendar/week?weekStart=2026-10-26&timezone=UTC")
      .set("Content-Length", "0")
      .expect(400, { error: "invalid-week-request" });
    await request(app)
      .post("/api/calendar/week?weekStart=2026-10-26&timezone=UTC")
      .expect(400, { error: "invalid-week-request" });
  });

  it("enforces the 2,048-byte raw target boundary before query semantics", async () => {
    const prefix = "/api/calendar/week?weekStart=2026-10-26&timezone=UTC&unknown=";
    const atLimit = `${prefix}${"x".repeat(2_048 - Buffer.byteLength(prefix))}`;
    const overLimit = `${atLimit}x`;
    expect(Buffer.byteLength(atLimit)).toBe(2_048);
    expect(Buffer.byteLength(overLimit)).toBe(2_049);
    await request(app).get(atLimit).expect(400, { error: "invalid-week-request" });
    await request(app).get(overLimit).expect(400, { error: "invalid-week-request" });
  });
});

describe("Week projection, closed union, and paging", () => {
  it("returns fixed, deadline, goal, and separate tracked identities without writes", async () => {
    await nativeWrite((database) => {
      database.prepare("INSERT OR IGNORE INTO categories(id,name,color,is_default) VALUES (990,'Week fixtures','#123456',0)").run();
      const task = database.prepare(
        "INSERT INTO tasks(id,title,category_id,due_date,status,created_at) VALUES (?,?,?,?,?,?)",
      );
      task.run(2001, "Dual task", 990, "2026-10-30", "open", "2026-01-01T00:00:00.000Z");
      task.run(2002, "Done fixed", 990, "2026-10-30", "done", "2026-01-01T00:00:00.000Z");
      task.run(2003, "Archived history", 990, null, "archived", "2026-01-01T00:00:00.000Z");
      database.prepare("INSERT INTO task_fixed_slots(task_id,starts_at,ends_at,entry_timezone) VALUES (?,?,?,?)")
        .run(2001, "2026-10-27T08:00:00.000Z", "2026-10-27T09:30:00.000Z", "Europe/Berlin");
      database.prepare("INSERT INTO task_fixed_slots(task_id,starts_at,ends_at,entry_timezone) VALUES (?,?,?,?)")
        .run(2002, "2026-10-28T08:00:00.000Z", "2026-10-28T09:00:00.000Z", "Europe/Berlin");
      database.prepare("INSERT INTO task_fixed_slots(task_id,starts_at,ends_at,entry_timezone) VALUES (?,?,?,?)")
        .run(2003, "2026-10-28T10:00:00.000Z", "2026-10-28T11:00:00.000Z", "Europe/Berlin");
      database.prepare("INSERT INTO goals(id,title,target_date,status,created_at) VALUES (?,?,?,?,?)")
        .run(2101, "Active goal", "2026-10-31", "active", "2026-01-01T00:00:00.000Z");
      const tracked = database.prepare("INSERT INTO time_entries(id,task_id,started_at,ended_at) VALUES (?,?,?,?)");
      tracked.run(3001, 2001, "2026-10-29T10:15:00.000Z", "2026-10-29T12:00:00.000Z");
      tracked.run(3002, 2003, "2026-10-30T22:00:00.000Z", "2026-10-31T01:00:00.000Z");
    });
    await makeProjectionReady();

    const before = await testDb();
    const countsBefore = before.prepare(`SELECT
      (SELECT COUNT(*) FROM tasks) AS tasks,
      (SELECT COUNT(*) FROM goals) AS goals,
      (SELECT COUNT(*) FROM time_entries) AS entries,
      (SELECT source_generation FROM week_access_state) AS sourceGeneration,
      (SELECT built_generation FROM week_access_state) AS builtGeneration`).get();
    before.close();

    const response = await request(app)
      .get("/api/calendar/week?weekStart=2026-10-26&timezone=Europe%2FBerlin")
      .expect(200);
    expect(response.body.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "task", id: 2001, title: "Dual task", status: "open",
        fixed: { startsAt: "2026-10-27T08:00:00.000Z", endsAt: "2026-10-27T09:30:00.000Z", contextDate: "2026-10-27" },
        deadline: { date: "2026-10-30" },
      }),
      expect.objectContaining({ kind: "task", id: 2002, status: "done", deadline: null }),
      expect.objectContaining({ kind: "goal", id: 2101, status: "active" }),
      expect.objectContaining({ kind: "tracked", id: 3001, taskId: 2001, taskStatus: "open", running: false }),
      expect.objectContaining({ kind: "tracked", id: 3002, taskId: 2003, taskStatus: "archived", running: false }),
    ]));
    expect(response.body.records).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "task", id: 2003 }),
    ]));

    const after = await testDb();
    expect(after.prepare(`SELECT
      (SELECT COUNT(*) FROM tasks) AS tasks,
      (SELECT COUNT(*) FROM goals) AS goals,
      (SELECT COUNT(*) FROM time_entries) AS entries,
      (SELECT source_generation FROM week_access_state) AS sourceGeneration,
      (SELECT built_generation FROM week_access_state) AS builtGeneration`).get()).toEqual(countsBefore);
    after.close();
  });

  it("keeps a valid lower-bound crossing fixed facet with nullable local context", async () => {
    await nativeWrite((database) => {
      database.prepare("INSERT OR IGNORE INTO categories(id,name,color,is_default) VALUES (990,'Week fixtures','#123456',0)").run();
      database.prepare(
        "INSERT INTO tasks(id,title,category_id,due_date,status,created_at) VALUES (2200,'Boundary fixed',990,'0001-01-03','open','0001-01-01T00:00:00.000Z')",
      ).run();
      database.prepare(
        "INSERT INTO task_fixed_slots(task_id,starts_at,ends_at,entry_timezone) VALUES (2200,'0001-01-01T00:00:00.000Z','0001-01-01T06:00:00.000Z','UTC')",
      ).run();
    });
    await makeProjectionReady();
    const response = await request(app)
      .get("/api/calendar/week?weekStart=0001-01-01&timezone=America%2FNew_York")
      .expect(200);
    expect(response.body.records).toEqual([
      expect.objectContaining({
        kind: "task",
        id: 2200,
        fixed: expect.objectContaining({ contextDate: null }),
        deadline: { date: "0001-01-03" },
      }),
    ]);
  });

  it("pages exactly 100 title-free ordered identities and binds the continuation", async () => {
    await nativeWrite((database) => {
      const insert = database.prepare(
        "INSERT INTO tasks(id,title,category_id,due_date,status,created_at) VALUES (?,?,990,'2026-11-13','open','2026-01-01T00:00:00.000Z')",
      );
      database.transaction(() => {
        for (let index = 0; index < 101; index += 1) insert.run(5000 + index, `Page ${index}`);
      })();
    });
    const first = await request(app)
      .get("/api/calendar/week?weekStart=2026-11-09&timezone=UTC")
      .expect(200);
    expect(first.body.records).toHaveLength(100);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await request(app)
      .get(`/api/calendar/week?weekStart=2026-11-09&timezone=UTC&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .expect(200);
    expect(second.body.records).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
    const ids = [...first.body.records, ...second.body.records].map((row) => row.id);
    expect(ids).toEqual(Array.from({ length: 101 }, (_, index) => 5000 + index));
    await request(app)
      .get(`/api/calendar/week?weekStart=2026-11-16&timezone=UTC&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .expect(400, { error: "invalid-week-request" });
    await request(app)
      .get(`/api/calendar/week?weekStart=2026-11-09&timezone=UTC&cursor=${encodeURIComponent(`${first.body.nextCursor}x`)}`)
      .expect(400, { error: "invalid-week-request" });
  });

  it("admits one computation and returns exact busy rather than coalescing an identical request", async () => {
    const target = "/api/calendar/week?weekStart=2026-11-09&timezone=UTC";
    const [left, right, health] = await Promise.all([
      request(app).get(target),
      request(app).get(target),
      request(app).get("/api/health"),
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 503]);
    const busy = left.status === 503 ? left : right;
    expect(busy.body).toEqual({ error: "week-projection-busy" });
    expect(busy.headers["cache-control"]).toBe("no-store");
    expect(health.status).toBe(200);
  });

  it("closes and lazily reopens the worker and rotates cursors only for a committed restore", async () => {
    const first = await request(app)
      .get("/api/calendar/week?weekStart=2026-11-09&timezone=UTC")
      .expect(200);
    const committedCursor = first.body.nextCursor as string;
    expect(committedCursor).toEqual(expect.any(String));

    const archive = createBackupArchive();
    try {
      const active = readWeekPage(resolveWeek("2026-11-09", "UTC")!, null);
      await expect(importBackupArchive(archive)).rejects.toEqual(
        expect.objectContaining<Partial<BackupError>>({
          status: 409,
          message: "a Week request is active; retry restore after it finishes",
        }),
      );
      await active;
      await request(app).post("/api/backup/import").attach("file", archive).expect(200);
    } finally {
      fs.rmSync(archive, { force: true });
    }
    await request(app)
      .get(`/api/calendar/week?weekStart=2026-11-09&timezone=UTC&cursor=${encodeURIComponent(committedCursor)}`)
      .expect(400, { error: "invalid-week-request" });

    const afterRestore = await request(app)
      .get("/api/calendar/week?weekStart=2026-11-09&timezone=UTC")
      .expect(200);
    const retainedCursor = afterRestore.body.nextCursor as string;
    const invalidArchive = path.join(process.env.DATA_DIR!, "invalid-week-restore.zip");
    fs.writeFileSync(invalidArchive, "not a zip");
    try {
      await request(app).post("/api/backup/import").attach("file", invalidArchive).expect(400);
    } finally {
      fs.rmSync(invalidArchive, { force: true });
    }
    await request(app)
      .get(`/api/calendar/week?weekStart=2026-11-09&timezone=UTC&cursor=${encodeURIComponent(retainedCursor)}`)
      .expect(200);
  });

  it("preserves a failed-reopen latch through unattempted restores until actual recovery", async () => {
    const week = resolveWeek("2026-11-09", "UTC")!;
    const beforePreCommit = await request(app)
      .get("/api/calendar/week?weekStart=2026-11-09&timezone=UTC")
      .expect(200);
    const retainedCursor = beforePreCommit.body.nextCursor as string;

    const preCommitArchive = createBackupArchive();
    try {
      await expect(importBackupArchive(preCommitArchive, undefined, {
        beforeDatabaseCommit: () => { throw new Error("injected pre-commit swap fault"); },
        reopenLiveDatabase: () => {
          reopenDatabase();
          throw new Error("injected missing reopen proof");
        },
      })).rejects.toThrow("injected missing reopen proof");
    } finally {
      fs.rmSync(preCommitArchive, { force: true });
    }
    expect(() => decodeWeekCursor(retainedCursor, week)).not.toThrow();
    await request(app)
      .get("/api/calendar/week?weekStart=2026-11-09&timezone=UTC")
      .expect(503, { error: "week-index-unavailable" });

    const invalidArchive = path.join(process.env.DATA_DIR!, "invalid-latched-week-restore.zip");
    fs.writeFileSync(invalidArchive, "not a zip");
    try {
      await expect(importBackupArchive(invalidArchive)).rejects.toMatchObject({ status: 400 });
    } finally {
      fs.rmSync(invalidArchive, { force: true });
    }
    expect(() => decodeWeekCursor(retainedCursor, week)).not.toThrow();
    await request(app)
      .get("/api/calendar/week?weekStart=2026-11-09&timezone=UTC")
      .expect(503, { error: "week-index-unavailable" });

    const recoveryArchive = createBackupArchive();
    let admissionDuringPushFailure: Promise<unknown> | undefined;
    const failingPush = {
      ...disabledPushDependency,
      beginRestore: () => {
        admissionDuringPushFailure = readWeekPage(week, null).then(
          () => ({ code: "unexpected-success" }),
          (error: unknown) => error,
        );
        throw new Error("injected Push beginRestore failure");
      },
    };
    try {
      await expect(importBackupArchive(recoveryArchive, failingPush))
        .rejects.toThrow("injected Push beginRestore failure");
      await expect(admissionDuringPushFailure).resolves.toMatchObject({ code: "busy" });
      expect(() => decodeWeekCursor(retainedCursor, week)).not.toThrow();
      await request(app)
        .get("/api/calendar/week?weekStart=2026-11-09&timezone=UTC")
        .expect(503, { error: "week-index-unavailable" });

      await expect(importBackupArchive(recoveryArchive)).resolves.toEqual(
        expect.objectContaining({ tasks: expect.any(Number) }),
      );
    } finally {
      fs.rmSync(recoveryArchive, { force: true });
    }
    expect(() => decodeWeekCursor(retainedCursor, week)).toThrow();
    await request(app)
      .get("/api/calendar/week?weekStart=2026-11-09&timezone=UTC")
      .expect(200);
  });

  it("keeps post-commit reopen-proof failure unavailable after rotating the key", async () => {
    const week = resolveWeek("2026-11-09", "UTC")!;
    const beforePostCommit = await request(app)
      .get("/api/calendar/week?weekStart=2026-11-09&timezone=UTC")
      .expect(200);
    const rotatedCursor = beforePostCommit.body.nextCursor as string;
    const postCommitArchive = createBackupArchive();
    try {
      await expect(importBackupArchive(postCommitArchive, undefined, {
        reopenLiveDatabase: () => {
          reopenDatabase();
          throw new Error("injected post-commit missing reopen proof");
        },
      })).resolves.toEqual(expect.objectContaining({ pushRecoveryPending: true }));
    } finally {
      fs.rmSync(postCommitArchive, { force: true });
    }
    expect(() => decodeWeekCursor(rotatedCursor, week)).toThrow();
    await request(app)
      .get("/api/calendar/week?weekStart=2026-11-09&timezone=UTC")
      .expect(503, { error: "week-index-unavailable" });

    const recoveryArchive = createBackupArchive();
    try {
      await expect(importBackupArchive(recoveryArchive)).resolves.toEqual(
        expect.objectContaining({ tasks: expect.any(Number) }),
      );
    } finally {
      fs.rmSync(recoveryArchive, { force: true });
    }
    await request(app)
      .get("/api/calendar/week?weekStart=2026-11-09&timezone=UTC")
      .expect(200);
  });

  it("bounds and code-point-safely truncates an oversized title without changing storage", async () => {
    const title = `${"😀".repeat(40_000)}suffix`;
    await nativeWrite((database) => {
      database.prepare(
        "INSERT INTO tasks(id,title,category_id,due_date,status,created_at) VALUES (7001,?,990,'2026-11-20','open','2026-01-01T00:00:00.000Z')",
      ).run(title);
    });
    const response = await request(app)
      .get("/api/calendar/week?weekStart=2026-11-16&timezone=UTC")
      .expect(200);
    expect(Buffer.byteLength(response.text, "utf8")).toBeLessThanOrEqual(131_072);
    expect(response.body.records).toHaveLength(1);
    expect(response.body.records[0]).toMatchObject({ id: 7001, titleTruncated: true });
    expect(title.startsWith(response.body.records[0].title)).toBe(true);
    const database = await testDb();
    expect(database.prepare("SELECT title FROM tasks WHERE id=7001").get()).toEqual({ title });
    database.close();
  });

  it("fails the whole page for a non-TEXT selected title without internal detail", async () => {
    await nativeWrite((database) => {
      database.prepare(
        "INSERT INTO tasks(id,title,category_id,due_date,status,created_at) VALUES (7002,CAST(X'313233' AS BLOB),990,'2026-11-27','open','2026-01-01T00:00:00.000Z')",
      ).run();
    });
    const response = await request(app)
      .get("/api/calendar/week?weekStart=2026-11-23&timezone=UTC")
      .expect(500)
      .expect("Cache-Control", "no-store")
      .expect("Content-Type", /json/);
    expect(response.body).toEqual({ error: "week-projection-failed" });
    await nativeWrite((database) => {
      database.prepare("DELETE FROM tasks WHERE id=7002").run();
      database.prepare(
        "INSERT INTO tasks(id,title,category_id,due_date,status,created_at) VALUES (7003,CAST(X'80' AS TEXT),990,'2026-11-27','open','2026-01-01T00:00:00.000Z')",
      ).run();
    });
    await request(app)
      .get("/api/calendar/week?weekStart=2026-11-23&timezone=UTC")
      .expect(500, { error: "week-projection-failed" });
    await nativeWrite((database) => database.prepare("DELETE FROM tasks WHERE id=7003").run());
  });

  it("fails closed for reached source/companion drift", async () => {
    await nativeWrite((database) => {
      database.prepare(
        "UPDATE task_fixed_slots SET ends_at='2026-10-27T10:00:00.000Z' WHERE task_id=2001",
      ).run();
      database.prepare(
        "UPDATE week_access_state SET built_generation=source_generation,ready=1 WHERE singleton=1",
      ).run();
    });
    await request(app)
      .get("/api/calendar/week?weekStart=2026-10-26&timezone=Europe%2FBerlin")
      .expect(503, { error: "week-index-unavailable" });
    await makeProjectionReady();
  });

  it("fails closed for unavailable state and returns only the documented error envelope", async () => {
    await nativeWrite((database) => {
      database.prepare("UPDATE week_access_state SET ready=0 WHERE singleton=1").run();
    });
    const unavailable = await request(app)
      .get("/api/calendar/week?weekStart=2026-11-23&timezone=UTC")
      .expect(503)
      .expect("Cache-Control", "no-store")
      .expect("Content-Type", /json/);
    expect(unavailable.body).toEqual({ error: "week-index-unavailable" });
    await nativeWrite((database) => {
      database.prepare(
        "UPDATE week_access_state SET built_generation=source_generation,ready=1 WHERE singleton=1",
      ).run();
    });
  });
});
