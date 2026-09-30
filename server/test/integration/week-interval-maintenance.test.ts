import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import type Database from "better-sqlite3";
import {
  beginWeekIntervalMutation,
  closeAllOpenTrackedIntervals,
  finalizeWeekIntervalMutation,
} from "../../src/db.js";
import { WEEK_PROJECTION_BATCH_SIZE, buildWeekProjection } from "../../src/schemaV23.js";
import { freshApp, testDb } from "../helpers.js";

let app: express.Express;
let database: Database.Database;

async function createTask(body: Record<string, unknown>): Promise<{ id: number }> {
  return (await request(app).post("/api/tasks").send({ categoryId: 1, ...body }).expect(201)).body;
}

function state(): { ready: number; sourceGeneration: number; builtGeneration: number } {
  return database.prepare(
    `SELECT ready,source_generation AS sourceGeneration,built_generation AS builtGeneration
     FROM week_access_state WHERE singleton=1`,
  ).get() as { ready: number; sourceGeneration: number; builtGeneration: number };
}

function forceReady(): void {
  database.transaction(() => {
    buildWeekProjection(database);
    database.prepare(
      "UPDATE week_access_state SET built_generation=source_generation,ready=1 WHERE singleton=1",
    ).run();
  })();
}

function interval(kind: number, sourceId: number): Record<string, unknown> | undefined {
  return database.prepare(
    `SELECT index_id AS indexId,source_kind AS sourceKind,source_id AS sourceId,
            task_id AS taskId,start_ms AS startMs,end_ms AS endMs,
            start_day AS startDay,end_day AS endDay
     FROM week_interval_access WHERE source_kind=? AND source_id=?`,
  ).get(kind, sourceId) as Record<string, unknown> | undefined;
}

beforeAll(async () => {
  app = await freshApp();
  database = await testDb();
});

describe("owned schema-v23 interval maintenance", () => {
  it("synchronizes fixed-slot set, replacement, and clear while preserving index identity", async () => {
    const task = await createTask({ title: "fixed projection" });
    const first = {
      startLocal: "2026-04-01T10:00",
      endLocal: "2026-04-01T11:00",
      entryTimezone: "UTC",
    };
    await request(app).patch(`/api/tasks/${task.id}`).send({ fixedSlot: first }).expect(200);
    const initial = interval(0, task.id)!;
    expect(initial).toMatchObject({ taskId: task.id, endMs: Date.parse("2026-04-01T11:00:00.000Z") });
    expect(state().ready).toBe(1);

    await request(app).patch(`/api/tasks/${task.id}`).send({
      fixedSlot: { ...first, endLocal: "2026-04-01T12:30" },
    }).expect(200);
    expect(interval(0, task.id)).toMatchObject({
      indexId: initial.indexId,
      endMs: Date.parse("2026-04-01T12:30:00.000Z"),
    });
    expect(state().ready).toBe(1);

    await request(app).patch(`/api/tasks/${task.id}`).send({ fixedSlot: null }).expect(200);
    expect(interval(0, task.id)).toBeUndefined();
    expect(database.prepare("SELECT COUNT(*) AS n FROM week_interval_rtree WHERE index_id=?").get(initial.indexId)).toEqual({ n: 0 });
    expect(state().ready).toBe(1);
  });

  it("timer start closes exactly one existing open entry and synchronizes both interval rows", async () => {
    const first = await createTask({ title: "one-open first", effortMinutes: 5 });
    const second = await createTask({ title: "one-open second", effortMinutes: 5 });
    await request(app).post(`/api/tasks/${first.id}/timer/start`).expect(200);
    const existing = database.prepare(
      "SELECT id FROM time_entries WHERE task_id=? AND ended_at IS NULL",
    ).get(first.id) as { id: number };
    expect(database.prepare("SELECT COUNT(*) AS count FROM time_entries WHERE ended_at IS NULL").get()).toEqual({ count: 1 });

    await request(app).post(`/api/tasks/${second.id}/timer/start`).expect(200);
    const entries = database.prepare(
      "SELECT id,task_id AS taskId,ended_at AS endedAt FROM time_entries ORDER BY id",
    ).all() as Array<{ id: number; taskId: number; endedAt: string | null }>;
    const replacement = entries.find((entry) => entry.endedAt === null)!;
    expect(entries.find((entry) => entry.id === existing.id)?.endedAt).not.toBeNull();
    expect(replacement.taskId).toBe(second.id);
    expect(entries.filter((entry) => entry.endedAt === null)).toHaveLength(1);
    expect(interval(2, existing.id)?.endMs).not.toBeNull();
    expect(interval(2, replacement.id)).toMatchObject({ taskId: second.id, endMs: null });
    for (const entry of entries) {
      const companion = interval(2, entry.id)!;
      expect(database.prepare(
        "SELECT start_day AS startDay,end_day AS endDay FROM week_interval_rtree WHERE index_id=?",
      ).get(companion.indexId)).toEqual({ startDay: companion.startDay, endDay: companion.endDay });
    }
    expect(state().ready).toBe(1);
    expect(state().builtGeneration).toBe(state().sourceGeneration);
  });

  it("maintains timer start close-all/insert, stop, split, completion, direct delete and cascades", async () => {
    const first = await createTask({ title: "timer first", effortMinutes: 5 });
    const second = await createTask({ title: "timer second", effortMinutes: 5 });
    await request(app).post(`/api/tasks/${first.id}/timer/start`).expect(200);
    let entries = database.prepare("SELECT id,ended_at AS endedAt FROM time_entries ORDER BY id").all() as Array<{ id: number; endedAt: string | null }>;
    expect(interval(2, entries.at(-1)!.id)).toMatchObject({ taskId: first.id, endMs: null });

    // Exercise the close-all path with multiple legacy/direct open rows while
    // presenting a clean projection at transaction entry.
    database.prepare("INSERT INTO time_entries(task_id,started_at) VALUES (?,?)").run(
      first.id,
      "2026-04-02T08:00:00.000Z",
    );
    database.prepare("INSERT INTO time_entries(task_id,started_at) VALUES (?,?)").run(
      first.id,
      "2026-04-02T09:00:00.000Z",
    );
    forceReady();
    await request(app).post(`/api/tasks/${second.id}/timer/start`).expect(200);
    entries = database.prepare("SELECT id,ended_at AS endedAt FROM time_entries ORDER BY id").all() as Array<{ id: number; endedAt: string | null }>;
    expect(entries.filter((row) => row.endedAt === null)).toHaveLength(1);
    for (const entry of entries) expect(interval(2, entry.id)).toBeDefined();
    expect(state().ready).toBe(1);

    const currentId = entries.find((row) => row.endedAt === null)!.id;
    await request(app).post("/api/timer/stop").expect(200);
    expect(interval(2, currentId)?.endMs).not.toBeNull();
    expect(state().ready).toBe(1);

    const parent = await createTask({ title: "split parent" });
    const child = await createTask({ title: "split child", parentId: parent.id, effortMinutes: 20 });
    await request(app).post(`/api/tasks/${child.id}/timer/start`).expect(200);
    const splitEntry = (database.prepare(
      "SELECT id FROM time_entries WHERE task_id=? AND ended_at IS NULL",
    ).get(child.id) as { id: number }).id;
    await request(app).post(`/api/tasks/${child.id}/split`).send({
      parts: [{ title: "part a", effortMinutes: 10 }, { title: "part b", effortMinutes: 10 }],
    }).expect(201);
    expect(interval(2, splitEntry)?.endMs).not.toBeNull();
    expect(state().ready).toBe(1);

    const complete = await createTask({ title: "complete projection", effortMinutes: 5 });
    await request(app).post(`/api/tasks/${complete.id}/timer/start`).expect(200);
    const completeEntry = (database.prepare(
      "SELECT id FROM time_entries WHERE task_id=? AND ended_at IS NULL",
    ).get(complete.id) as { id: number }).id;
    await request(app).patch(`/api/tasks/${complete.id}`).send({ status: "done" }).expect(200);
    expect(interval(2, completeEntry)?.endMs).not.toBeNull();
    expect(state().ready).toBe(1);

    const doomed = await createTask({
      title: "cascade projection",
      fixedSlot: { startLocal: "2026-05-01T10:00", endLocal: "2026-05-01T11:00", entryTimezone: "UTC" },
    });
    await request(app).post(`/api/tasks/${doomed.id}/timer/start`).expect(200);
    expect(database.prepare("SELECT COUNT(*) AS n FROM week_interval_access WHERE task_id=?").get(doomed.id)).toEqual({ n: 2 });
    await request(app).delete(`/api/tasks/${doomed.id}`).expect(200);
    expect(database.prepare("SELECT COUNT(*) AS n FROM week_interval_access WHERE task_id=?").get(doomed.id)).toEqual({ n: 0 });
    expect(state().ready).toBe(1);
  });

  it("closes many open entries through bounded returned-identity batches atomically", async () => {
    const task = await createTask({ title: "many open entries" });
    const insert = database.prepare(
      "INSERT INTO time_entries(task_id,started_at) VALUES (?,'2026-08-01T00:00:00.000Z')",
    );
    const ids: number[] = [];
    const openCount = WEEK_PROJECTION_BATCH_SIZE * 2 + 17;
    database.transaction(() => {
      for (let index = 0; index < openCount; index += 1) {
        ids.push(Number(insert.run(task.id).lastInsertRowid));
      }
    })();
    forceReady();
    const before = state();

    database.exec(`CREATE TEMP TRIGGER fail_many_open_projection
      BEFORE UPDATE ON week_interval_access
      BEGIN SELECT RAISE(ABORT,'injected many-open projection failure'); END`);
    try {
      expect(() => database.transaction(() => {
        const token = beginWeekIntervalMutation();
        closeAllOpenTrackedIntervals(token, "2026-08-01T01:00:00.000Z");
        finalizeWeekIntervalMutation(token);
      })()).toThrow(/injected many-open projection failure/);
    } finally {
      database.exec("DROP TRIGGER fail_many_open_projection");
    }
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM time_entries WHERE ended_at IS NULL",
    ).get()).toEqual({ count: openCount });
    expect(state()).toEqual(before);

    const batches: Array<{ rowCount: number; retainedIdentityCount: number }> = [];
    database.transaction(() => {
      const token = beginWeekIntervalMutation();
      closeAllOpenTrackedIntervals(
        token,
        "2026-08-01T01:00:00.000Z",
        { identityBatch: (batch) => batches.push(batch) },
      );
      finalizeWeekIntervalMutation(token);
    })();

    expect(batches.length).toBeGreaterThan(2);
    expect(Math.max(...batches.map((batch) => batch.retainedIdentityCount))).toBeLessThanOrEqual(
      WEEK_PROJECTION_BATCH_SIZE,
    );
    expect(batches.reduce((total, batch) => total + batch.rowCount, 0)).toBe(openCount);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM time_entries WHERE ended_at IS NULL",
    ).get()).toEqual({ count: 0 });
    for (const id of ids) expect(interval(2, id)?.endMs).not.toBeNull();
    expect(state().ready).toBe(1);
    expect(state().builtGeneration).toBe(state().sourceGeneration);
  });

  it("rolls source, companion, RTree and state back together on projection failure", async () => {
    const task = await createTask({ title: "rollback projection" });
    const before = state();
    database.exec(`CREATE TEMP TRIGGER fail_week_projection
      BEFORE INSERT ON week_interval_access
      BEGIN SELECT RAISE(ABORT,'injected week projection failure'); END`);
    try {
      await request(app).patch(`/api/tasks/${task.id}`).send({
        fixedSlot: { startLocal: "2026-06-01T10:00", endLocal: "2026-06-01T11:00", entryTimezone: "UTC" },
      }).expect(500);
    } finally {
      database.exec("DROP TRIGGER fail_week_projection");
    }
    expect(database.prepare("SELECT * FROM task_fixed_slots WHERE task_id=?").get(task.id)).toBeUndefined();
    expect(interval(0, task.id)).toBeUndefined();
    expect(database.prepare("SELECT COUNT(*) AS n FROM week_interval_rtree").get()).toEqual({
      n: (database.prepare("SELECT COUNT(*) AS n FROM week_interval_access").get() as { n: number }).n,
    });
    expect(state()).toEqual(before);
  });

  it("reprojects affected identities but never declares a dirty-at-entry transaction globally ready", async () => {
    const direct = await createTask({ title: "direct dirty" });
    database.prepare("INSERT INTO time_entries(task_id,started_at) VALUES (?,?)").run(
      direct.id,
      "2026-07-01T00:00:00.000Z",
    );
    expect(state().ready).toBe(0);
    const owned = await createTask({ title: "owned while dirty" });
    await request(app).post(`/api/tasks/${owned.id}/timer/start`).expect(200);
    const rows = database.prepare("SELECT id FROM time_entries ORDER BY id").all() as Array<{ id: number }>;
    for (const row of rows) expect(interval(2, row.id)).toBeDefined();
    expect(state().ready).toBe(0);
    expect(state().builtGeneration).toBeLessThan(state().sourceGeneration);
    forceReady();
  });
});
