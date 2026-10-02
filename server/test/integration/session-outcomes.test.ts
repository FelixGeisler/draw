import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type express from "express";
import { freshApp, testDb } from "../helpers.js";
import {
  beginWeekMutation,
  closeOpenTrackedIntervals,
  finishWeekMutation,
} from "../../src/schemaV23.js";

let app: express.Express;

beforeAll(async () => {
  app = await freshApp();
});

beforeEach(async () => {
  const database = await testDb();
  database.prepare("DELETE FROM tasks").run();
  database.close();
});

async function createTask(title: string, extra: Record<string, unknown> = {}) {
  return (await request(app).post("/api/tasks").send({ title, categoryId: 1, ...extra }).expect(201)).body as {
    id: number;
  };
}

async function entries(taskId?: number) {
  const database = await testDb();
  const rows = taskId === undefined
    ? database.prepare(
      "SELECT id,task_id AS taskId,started_at AS startedAt,ended_at AS endedAt,end_reason AS endReason FROM time_entries ORDER BY id",
    ).all()
    : database.prepare(
      "SELECT id,task_id AS taskId,started_at AS startedAt,ended_at AS endedAt,end_reason AS endReason FROM time_entries WHERE task_id=? ORDER BY id",
    ).all(taskId);
  database.close();
  return rows as Array<{
    id: number;
    taskId: number;
    startedAt: string;
    endedAt: string | null;
    endReason: "done" | "stop" | null;
  }>;
}

describe("authoritative session outcomes", () => {
  it("classifies replacement Start and explicit Stop, including same-task restarts", async () => {
    const first = await createTask("first");
    const second = await createTask("second");
    await request(app).post(`/api/tasks/${first.id}/timer/start`).expect(200);
    await request(app).post(`/api/tasks/${second.id}/timer/start`).expect(200);
    await request(app).post("/api/timer/stop").expect(200);
    await request(app).post(`/api/tasks/${second.id}/timer/start`).expect(200);

    const rows = await entries();
    expect(rows.map(({ taskId, endReason }) => ({ taskId, endReason }))).toEqual([
      { taskId: first.id, endReason: "stop" },
      { taskId: second.id, endReason: "stop" },
      { taskId: second.id, endReason: null },
    ]);
    expect(rows[2].endedAt).toBeNull();
  });

  it("classifies direct and recurring completion done without touching another task's timer", async () => {
    const running = await createTask("still running");
    const completed = await createTask("completed elsewhere");
    await request(app).post(`/api/tasks/${running.id}/timer/start`).expect(200);
    await request(app).patch(`/api/tasks/${completed.id}`).send({ status: "done" }).expect(200);
    expect((await entries(running.id))[0]).toMatchObject({ endedAt: null, endReason: null });

    await request(app).patch(`/api/tasks/${running.id}`).send({ status: "done" }).expect(200);
    expect((await entries(running.id))[0].endReason).toBe("done");

    const recurring = await createTask("recurring", { recurEveryDays: 1 });
    await request(app).post(`/api/tasks/${recurring.id}/timer/start`).expect(200);
    const response = await request(app)
      .patch(`/api/tasks/${recurring.id}`)
      .send({ status: "done" })
      .expect(200);
    expect(response.body.recurring).toBe(true);
    expect((await entries(recurring.id))[0].endReason).toBe("done");
  });

  it("validates every future classified domain before all/task/current writes and rolls back", async () => {
    const allSource = await createTask("unsafe all source");
    const allReplacement = await createTask("unsafe all replacement");
    let database = await testDb();
    database.prepare(
      "INSERT INTO time_entries(id,task_id,started_at) VALUES (?,?,?)",
    ).run(9_007_199_254_740_992n, allSource.id, "2026-01-01T00:00:00.000Z");
    database.close();
    await request(app).post(`/api/tasks/${allReplacement.id}/timer/start`).expect(500);
    expect(await entries(allReplacement.id)).toEqual([]);
    expect((await entries(allSource.id))[0]).toMatchObject({ endedAt: null, endReason: null });
    await request(app).delete(`/api/tasks/${allSource.id}`).expect(200);

    const lowIdSource = await createTask("low id all source");
    const lowIdReplacement = await createTask("low id all replacement");
    database = await testDb();
    database.prepare(
      "INSERT INTO time_entries(id,task_id,started_at) VALUES (?,?,?)",
    ).run(0, lowIdSource.id, "2026-01-01T00:00:00.000Z");
    database.close();
    await request(app).post(`/api/tasks/${lowIdReplacement.id}/timer/start`).expect(500);
    expect(await entries(lowIdReplacement.id)).toEqual([]);
    expect((await entries(lowIdSource.id))[0]).toMatchObject({ endedAt: null, endReason: null });
    await request(app).delete(`/api/tasks/${lowIdSource.id}`).expect(200);

    const taskScope = await createTask("malformed task scope");
    database = await testDb();
    database.prepare(
      "INSERT INTO time_entries(task_id,started_at) VALUES (?,?)",
    ).run(taskScope.id, "not-a-canonical-timestamp");
    database.close();
    await request(app).patch(`/api/tasks/${taskScope.id}`).send({ status: "done" }).expect(500);
    database = await testDb();
    expect(database.prepare("SELECT status FROM tasks WHERE id=?").get(taskScope.id)).toEqual({
      status: "open",
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS n FROM completions WHERE task_id=?",
    ).get(taskScope.id)).toEqual({ n: 0 });
    database.close();
    expect((await entries(taskScope.id))[0]).toMatchObject({ endedAt: null, endReason: null });
    await request(app).delete(`/api/tasks/${taskScope.id}`).expect(200);

    const currentScope = await createTask("future current scope");
    database = await testDb();
    database.prepare(
      "INSERT INTO time_entries(task_id,started_at) VALUES (?,?)",
    ).run(currentScope.id, "9999-12-31T23:59:59.999Z");
    database.close();
    await request(app).post("/api/timer/stop").expect(500);
    expect((await entries(currentScope.id))[0]).toMatchObject({ endedAt: null, endReason: null });
    await request(app).delete(`/api/tasks/${currentScope.id}`).expect(200);

    const invalidEnd = await createTask("invalid end domain");
    database = await testDb();
    const entryId = Number(database.prepare(
      "INSERT INTO time_entries(task_id,started_at) VALUES (?,?)",
    ).run(invalidEnd.id, "2026-01-01T00:00:00.000Z").lastInsertRowid);
    expect(() => database.transaction(() => {
      const token = beginWeekMutation(database);
      closeOpenTrackedIntervals(
        database,
        token,
        "2026-01-01T00:00:00.00Z",
        "done",
        { kind: "identity", entryId },
      );
      finishWeekMutation(database, token);
    })()).toThrow(/outcome domain/);
    database.close();
    expect((await entries(invalidEnd.id))[0]).toMatchObject({ endedAt: null, endReason: null });
  });

  it("classifies an admitted legacy open row at zero duration and omits it from Week", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-05T06:07:08.009Z"));
    try {
      const task = await createTask("legacy zero duration");
      const database = await testDb();
      database.prepare(
        "INSERT INTO time_entries(task_id,started_at) VALUES (?,?)",
      ).run(task.id, "2026-04-05T06:07:08.009Z");
      database.close();

      await request(app).post("/api/timer/stop").expect(200);
      expect((await entries(task.id))[0]).toMatchObject({
        startedAt: "2026-04-05T06:07:08.009Z",
        endedAt: "2026-04-05T06:07:08.009Z",
        endReason: "stop",
      });
      const after = await testDb();
      expect(after.prepare(
        "SELECT COUNT(*) AS n FROM week_interval_access WHERE source_kind=2",
      ).get()).toEqual({ n: 0 });
      after.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps first committed close immutable and reopening never rewrites its reason", async () => {
    const task = await createTask("race");
    await request(app).post(`/api/tasks/${task.id}/timer/start`).expect(200);
    const [stop, complete] = await Promise.all([
      request(app).post("/api/timer/stop"),
      request(app).patch(`/api/tasks/${task.id}`).send({ status: "done" }),
    ]);
    expect([200, 404]).toContain(stop.status);
    expect(complete.status).toBe(200);
    const closed = (await entries(task.id))[0];
    expect(["done", "stop"]).toContain(closed.endReason);
    expect(closed.endedAt).not.toBeNull();

    await request(app).patch(`/api/tasks/${task.id}`).send({ status: "open" }).expect(200);
    expect((await entries(task.id))[0]).toEqual(closed);
    await request(app).post(`/api/tasks/${task.id}/timer/start`).expect(200);
    expect(await entries(task.id)).toHaveLength(2);
  });

  it("does not close an archived task, but child archive can complete a timed parent done", async () => {
    const own = await createTask("archive own timer");
    await request(app).post(`/api/tasks/${own.id}/timer/start`).expect(200);
    await request(app).patch(`/api/tasks/${own.id}`).send({ status: "archived" }).expect(200);
    expect((await entries(own.id))[0]).toMatchObject({ endedAt: null, endReason: null });
    await request(app).delete(`/api/tasks/${own.id}`).expect(200);

    const parent = await createTask("archive parent");
    const children = (await request(app).post(`/api/tasks/${parent.id}/subtasks`).send({
      subtasks: [
        { title: "done child", effortMinutes: 1 },
        { title: "archive child", effortMinutes: 1 },
      ],
    }).expect(201)).body as Array<{ id: number }>;
    await request(app).patch(`/api/tasks/${children[0].id}`).send({ status: "done" }).expect(200);
    await request(app).post(`/api/tasks/${parent.id}/timer/start`).expect(200);
    await request(app).patch(`/api/tasks/${children[1].id}`).send({ status: "archived" }).expect(200);
    expect((await entries(parent.id))[0].endReason).toBe("done");
    expect(await entries(children[1].id)).toEqual([]);
  });

  it("deletion erases its subtree sessions while child deletion may complete a surviving parent done", async () => {
    const parent = await createTask("delete parent");
    const children = (await request(app).post(`/api/tasks/${parent.id}/subtasks`).send({
      subtasks: [
        { title: "done child", effortMinutes: 1 },
        { title: "delete child", effortMinutes: 1 },
      ],
    }).expect(201)).body as Array<{ id: number }>;
    await request(app).post(`/api/tasks/${children[0].id}/timer/start`).expect(200);
    await request(app).patch(`/api/tasks/${children[0].id}`).send({ status: "done" }).expect(200);
    await request(app).post(`/api/tasks/${children[1].id}/timer/start`).expect(200);
    await request(app).post(`/api/tasks/${parent.id}/timer/start`).expect(200);
    await request(app).delete(`/api/tasks/${children[1].id}`).expect(200);
    expect(await entries(children[1].id)).toEqual([]);
    expect((await entries(parent.id))[0].endReason).toBe("done");

    await request(app).delete(`/api/tasks/${parent.id}`).expect(200);
    expect(await entries()).toEqual([]);
  });
});
