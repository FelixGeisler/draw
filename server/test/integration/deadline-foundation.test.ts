import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import type Database from "better-sqlite3";
import { freshApp, testDb } from "../helpers.js";
import { isCalendarDate } from "../../src/services/taskWrites.js";

let app: express.Express;
let database: Database.Database;

beforeAll(async () => {
  app = await freshApp();
  database = await testDb();
});

function insertDevice(id: string) {
  database
    .prepare(
      `INSERT INTO push_subscriptions
       (id, endpoint, p256dh, auth, expiration_time, created_at, last_seen_at)
       VALUES (?, ?, 'synthetic-p256dh', 'synthetic-auth', NULL, ?, ?)`,
    )
    .run(id, `https://push.invalid/${id}`, "2026-09-20T00:00:00.000Z", "2026-09-20T00:00:00.000Z");
}

function insertClaim(
  deviceId: string,
  itemType: "task" | "goal",
  itemId: number,
  suffix: string,
) {
  database
    .prepare(
      `INSERT INTO deadline_reminder_claims
       (device_id, item_type, item_id, item_created_at, deadline)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(deviceId, itemType, itemId, `created-${suffix}`, `deadline-${suffix}`);
}

function claims(itemType?: "task" | "goal") {
  return database
    .prepare(
      `SELECT item_type AS itemType, item_id AS itemId, item_created_at AS createdAt,
              deadline, device_id AS deviceId
       FROM deadline_reminder_claims
       ${itemType ? "WHERE item_type = ?" : ""}
       ORDER BY item_type, item_id, item_created_at`,
    )
    .all(...(itemType ? [itemType] : []));
}

describe("shared Gregorian date validation", () => {
  it.each(["0001-01-01", "0099-12-31", "2000-02-29", "2026-09-20", "9999-12-31"])(
    "accepts the real boundary date %s for tasks and goals",
    async (date) => {
      expect(isCalendarDate(date)).toBe(true);
      const task = await request(app)
        .post("/api/tasks")
        .send({ title: `task-${date}`, categoryId: 1, dueDate: date })
        .expect(201);
      expect(task.body.dueDate).toBe(date);
      const goal = await request(app)
        .post("/api/goals")
        .send({ title: `goal-${date}`, targetDate: date })
        .expect(201);
      expect(goal.body.targetDate).toBe(date);
    },
  );

  it.each([
    "0000-01-01",
    "10000-01-01",
    "+2026-01-01",
    "2026-1-01",
    "2026-01-1",
    "1900-02-29",
    "2000-02-30",
    "2026-04-31",
    "2026-01-01T00:00:00Z",
    " 2026-01-01",
  ])("rejects noncanonical or impossible date %s without a task write", async (date) => {
    expect(isCalendarDate(date)).toBe(false);
    const title = `invalid-task-${date}`;
    const response = await request(app)
      .post("/api/tasks")
      .send({ title, categoryId: 1, dueDate: date })
      .expect(400);
    expect(response.body).toEqual({ error: "dueDate must be a YYYY-MM-DD string" });
    expect(database.prepare("SELECT id FROM tasks WHERE title = ?").get(title)).toBeUndefined();
  });

  it("rejects every non-null invalid goal target before writes or achievement side effects", async () => {
    const invalid: unknown[] = ["0000-01-01", "2026-02-30", "2026-2-03", 20260920, true, {}, []];
    for (const [index, targetDate] of invalid.entries()) {
      const title = `invalid-goal-${index}`;
      const response = await request(app)
        .post("/api/goals")
        .send({ title, targetDate })
        .expect(400);
      expect(response.body).toEqual({ error: "targetDate must be a YYYY-MM-DD string" });
      expect(database.prepare("SELECT id FROM goals WHERE title = ?").get(title)).toBeUndefined();
    }

    const goal = (await request(app).post("/api/goals").send({ title: "side-effect guard" }).expect(201)).body;
    const achievementsBefore = database.prepare("SELECT COUNT(*) AS n FROM achievements").get();
    const patch = await request(app)
      .patch(`/api/goals/${goal.id}`)
      .send({ targetDate: "2026-02-30", status: "achieved" })
      .expect(400);
    expect(patch.body).toEqual({ error: "targetDate must be a YYYY-MM-DD string" });
    expect(database.prepare("SELECT status, target_date AS targetDate FROM goals WHERE id = ?").get(goal.id)).toEqual({
      status: "active",
      targetDate: null,
    });
    expect(database.prepare("SELECT COUNT(*) AS n FROM achievements").get()).toEqual(achievementsBefore);
  });

  it("keeps absent/null dates valid and preserves malformed legacy rows without rewriting", async () => {
    const task = (await request(app).post("/api/tasks").send({ title: "nullable task", categoryId: 1 }).expect(201)).body;
    await request(app).patch(`/api/tasks/${task.id}`).send({ dueDate: null }).expect(200);
    const goal = (await request(app).post("/api/goals").send({ title: "nullable goal", targetDate: null }).expect(201)).body;
    await request(app).patch(`/api/goals/${goal.id}`).send({ targetDate: null }).expect(200);

    database.prepare("UPDATE tasks SET due_date = 'legacy-impossible' WHERE id = ?").run(task.id);
    database.prepare("UPDATE goals SET target_date = '0000-01-01' WHERE id = ?").run(goal.id);
    const tasks = (await request(app).get("/api/tasks?status=all").expect(200)).body;
    expect(tasks.find((row: { id: number }) => row.id === task.id).dueDate).toBe("legacy-impossible");
    const goals = (await request(app).get("/api/goals?status=all").expect(200)).body;
    expect(goals.find((row: { id: number }) => row.id === goal.id).targetDate).toBe("0000-01-01");
    expect(database.prepare("SELECT due_date AS value FROM tasks WHERE id = ?").get(task.id)).toEqual({
      value: "legacy-impossible",
    });
  });
});

describe("deadline claim lifecycle", () => {
  it("subscription deletion cascades every claim for that device only", () => {
    insertDevice("claim-device-a");
    insertDevice("claim-device-b");
    insertClaim("claim-device-a", "task", 1001, "a-task");
    insertClaim("claim-device-a", "goal", 1002, "a-goal");
    insertClaim("claim-device-b", "task", 1001, "b-task");

    database.prepare("DELETE FROM push_subscriptions WHERE id = ?").run("claim-device-a");
    expect(claims()).toEqual([
      {
        itemType: "task",
        itemId: 1001,
        createdAt: "created-b-task",
        deadline: "deadline-b-task",
        deviceId: "claim-device-b",
      },
    ]);
    database.prepare("DELETE FROM push_subscriptions WHERE id = ?").run("claim-device-b");
  });

  it("task deletion atomically removes addressed and cascade-deleted descendant claims", async () => {
    insertDevice("claim-task-delete");
    const parent = (await request(app).post("/api/tasks").send({ title: "claim parent", categoryId: 1 }).expect(201)).body;
    const children = (
      await request(app)
        .post(`/api/tasks/${parent.id}/subtasks`)
        .send({ subtasks: [{ title: "claim child one" }, { title: "claim child two" }] })
        .expect(201)
    ).body;
    const survivor = (await request(app).post("/api/tasks").send({ title: "claim survivor", categoryId: 1 }).expect(201)).body;
    for (const [id, suffix] of [
      [parent.id, "parent-a"],
      [parent.id, "parent-b"],
      [children[0].id, "child-one"],
      [children[1].id, "child-two"],
      [survivor.id, "survivor"],
    ] as [number, string][]) insertClaim("claim-task-delete", "task", id, suffix);

    await request(app).delete(`/api/tasks/${parent.id}`).expect(200);
    expect((claims("task") as { itemId: number }[]).map((claim) => claim.itemId)).toEqual([survivor.id]);
    database.prepare("DELETE FROM push_subscriptions WHERE id = ?").run("claim-task-delete");
  });

  it("goal deletion removes only goal claims; linked tasks and their claims remain", async () => {
    insertDevice("claim-goal-delete");
    const goal = (await request(app).post("/api/goals").send({ title: "claim goal" }).expect(201)).body;
    const task = (
      await request(app)
        .post("/api/tasks")
        .send({ title: "linked claim task", categoryId: 1, goalId: goal.id })
        .expect(201)
    ).body;
    insertClaim("claim-goal-delete", "goal", goal.id, "goal-a");
    insertClaim("claim-goal-delete", "goal", goal.id, "goal-b");
    insertClaim("claim-goal-delete", "task", task.id, "task");

    await request(app).delete(`/api/goals/${goal.id}`).expect(200);
    expect(claims("goal")).toEqual([]);
    expect(database.prepare("SELECT goal_id AS goalId FROM tasks WHERE id = ?").get(task.id)).toEqual({ goalId: null });
    expect((claims("task") as { itemId: number }[]).map((claim) => claim.itemId)).toContain(task.id);
    database.prepare("DELETE FROM push_subscriptions WHERE id = ?").run("claim-goal-delete");
  });

  it("status, completion, deadline and goal-resolution edits retain source claims", async () => {
    insertDevice("claim-retention");
    const goal = (await request(app).post("/api/goals").send({ title: "retained goal", targetDate: "2026-10-01" }).expect(201)).body;
    const task = (
      await request(app)
        .post("/api/tasks")
        .send({ title: "retained task", categoryId: 1, effortMinutes: 5, dueDate: "2026-10-01" })
        .expect(201)
    ).body;
    insertClaim("claim-retention", "goal", goal.id, "goal");
    insertClaim("claim-retention", "task", task.id, "task");

    await request(app).patch(`/api/tasks/${task.id}`).send({ dueDate: "2026-10-02" }).expect(200);
    await request(app).patch(`/api/tasks/${task.id}`).send({ status: "done" }).expect(200);
    await request(app).patch(`/api/goals/${goal.id}`).send({ targetDate: "2026-10-02", status: "missed" }).expect(200);
    expect(claims()).toHaveLength(2);
    database.prepare("DELETE FROM push_subscriptions WHERE id = ?").run("claim-retention");
  });
});
