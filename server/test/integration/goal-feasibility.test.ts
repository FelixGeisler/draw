import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import type Database from "better-sqlite3";
import { freshApp, testDb } from "../helpers.js";

// #60: GET /api/goals derives the feasibility inputs at query time —
// remainingOpenEffortMinutes over open LEAF tasks only, trackedMinutes14d
// with the stats MINUTES_EXPR semantics. Derivation only: no schema change.

let app: express.Express;
let db: Database.Database;

beforeAll(async () => {
  app = await freshApp();
  db = await testDb();
});

const DAY = 24 * 3600 * 1000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

async function makeGoal(title: string) {
  return (await request(app).post("/api/goals").send({ title, targetDate: "2027-01-01" })).body;
}

async function makeTask(goalId: number, title: string, effortMinutes: number | null) {
  return (
    await request(app).post("/api/tasks").send({ title, categoryId: 1, goalId, effortMinutes })
  ).body;
}

async function goalRow(id: number) {
  const goals = (await request(app).get("/api/goals").expect(200)).body;
  return goals.find((g: { id: number }) => g.id === id);
}

function insertEntry(taskId: number, startedAt: string, endedAt: string | null) {
  db.prepare("INSERT INTO time_entries (task_id, started_at, ended_at) VALUES (?, ?, ?)").run(
    taskId,
    startedAt,
    endedAt,
  );
}

describe("remainingOpenEffortMinutes (leaf-only sum)", () => {
  it("a broken-down parent contributes its open subtasks' sum, never its own estimate on top", async () => {
    const goal = await makeGoal("Leaf sum");
    const parent = await makeTask(goal.id, "parent", 60);
    const subtasks = (
      await request(app)
        .post(`/api/tasks/${parent.id}/subtasks`)
        .send({
          subtasks: [
            { title: "step 1", effortMinutes: 20 },
            { title: "step 2", effortMinutes: 30 },
          ],
        })
        .expect(201)
    ).body;
    await makeTask(goal.id, "standalone", 15);

    // Subtasks inherit goal_id (#29) — a naive goal_id sum would give
    // 60 + 20 + 30 + 15; the leaf rule gives 20 + 30 + 15.
    expect((await goalRow(goal.id)).remainingOpenEffortMinutes).toBe(65);

    // Tracked minutes attribute through subtasks too: an entry on a subtask
    // counts for the goal because subtasks inherit goal_id (#29).
    insertEntry(subtasks[0].id, iso(60 * 60_000), iso(35 * 60_000));
    expect((await goalRow(goal.id)).trackedMinutes14d).toBe(25);

    // Closing one step shrinks the sum to the still-open leaves.
    await request(app).patch(`/api/tasks/${subtasks[0].id}`).send({ status: "done" }).expect(200);
    expect((await goalRow(goal.id)).remainingOpenEffortMinutes).toBe(45);

    // All steps closed: the still-open parent is a leaf again — its own
    // estimate returns, mirroring the tasks list's remainingEffortMinutes.
    await request(app).patch(`/api/tasks/${subtasks[1].id}`).send({ status: "done" }).expect(200);
    expect((await goalRow(goal.id)).remainingOpenEffortMinutes).toBe(75);
  });

  it("is NULL when no open leaf carries an estimate — even under an estimated parent", async () => {
    const goal = await makeGoal("Unestimated");
    const parent = await makeTask(goal.id, "estimated parent", 90);
    await request(app)
      .post(`/api/tasks/${parent.id}/subtasks`)
      .send({ subtasks: [{ title: "vague step" }] })
      .expect(201);

    // The only open leaf (the subtask) is unestimated; the parent's 90 must
    // not leak through. SUM over NULLs is NULL — "no data", not 0.
    expect((await goalRow(goal.id)).remainingOpenEffortMinutes).toBeNull();
  });
});

describe("trackedMinutes14d (stats MINUTES_EXPR semantics)", () => {
  it("counts only entries started in the last 14 days", async () => {
    const goal = await makeGoal("Window");
    const task = await makeTask(goal.id, "windowed", 30);

    // 15 days old: outside. 5 days old, 30 minutes long: inside.
    insertEntry(task.id, iso(15 * DAY), iso(15 * DAY - 60 * 60_000));
    insertEntry(task.id, iso(5 * DAY), iso(5 * DAY - 30 * 60_000));

    expect((await goalRow(goal.id)).trackedMinutes14d).toBe(30);
  });

  it("counts a running entry up to now", async () => {
    const goal = await makeGoal("Running");
    const task = await makeTask(goal.id, "in progress", 30);
    insertEntry(task.id, iso(30 * 60_000), null);

    const row = await goalRow(goal.id);
    expect(row.trackedMinutes14d).toBeGreaterThanOrEqual(30);
    expect(row.trackedMinutes14d).toBeLessThanOrEqual(31);
  });
});

describe("edges and invariants", () => {
  it("a goal without tasks derives NULL effort and zero tracked minutes", async () => {
    const goal = await makeGoal("Empty");
    const row = await goalRow(goal.id);
    expect(row.remainingOpenEffortMinutes).toBeNull();
    expect(row.trackedMinutes14d).toBe(0);
  });

  it("is a pure derivation: user_version is unchanged", async () => {
    // CURRENT_VERSION, not a literal: this asserts "reads don't migrate",
    // and must not fail every time an unrelated migration lands.
    const { CURRENT_VERSION } = await import("../../src/db.js");
    expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_VERSION);
  });
});
