import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import type Database from "better-sqlite3";
import { freshApp, testDb } from "../helpers.js";

// Issue #19 (ADR-17): snooze and block take cards out of the deck as a
// derived predicate — blocked = 0 AND (deferred_until IS NULL OR <= now).
// Each test draws from its own goal-scoped pool, like draw-current.test.ts,
// so the roulette pick is deterministic.

let app: express.Express;
let db: Database.Database;

beforeAll(async () => {
  app = await freshApp();
  db = await testDb();
});

async function seedGoalTask(
  title: string,
  taskOverrides: Record<string, unknown> = {},
): Promise<{ goalId: number; task: Record<string, any> }> {
  const goal = (await request(app).post("/api/goals").send({ title }).expect(201)).body;
  const task = (
    await request(app)
      .post("/api/tasks")
      .send({ title: `${title} task`, categoryId: 1, goalId: goal.id, effortMinutes: 10, ...taskOverrides })
      .expect(201)
  ).body;
  return { goalId: goal.id, task };
}

async function draw(goalId: number) {
  return (await request(app).post("/api/draw").send({ goalId }).expect(200)).body;
}

async function patchTask(id: number, patch: Record<string, unknown>, status = 200) {
  return (await request(app).patch(`/api/tasks/${id}`).send(patch).expect(status)).body;
}

const inOneHour = () => new Date(Date.now() + 3_600_000).toISOString();
const oneHourAgo = () => new Date(Date.now() - 3_600_000).toISOString();

describe("pool exclusion", () => {
  it("never draws a blocked task or one deferred into the future — the pool reports no_ready_tasks", async () => {
    const a = await seedGoalTask("excluded-blocked");
    const b = (
      await request(app)
        .post("/api/tasks")
        .send({ title: "excluded-snoozed task", categoryId: 1, goalId: a.goalId, effortMinutes: 5 })
        .expect(201)
    ).body;
    await patchTask(a.task.id, { blocked: true });
    await patchTask(b.id, { deferredUntil: inOneHour() });

    for (let i = 0; i < 10; i++) {
      const res = await draw(a.goalId);
      expect(res.task).toBeNull();
      // Snoozed cards come back on their own — the reason must not send the
      // user to the breakdown flow.
      expect(res.reason).toBe("no_ready_tasks");
    }
  });

  it("keeps all_too_big when an oversized (non-snoozed) card remains", async () => {
    const { goalId, task } = await seedGoalTask("mixed-reasons");
    await request(app)
      .post("/api/tasks")
      .send({ title: "mixed-reasons big task", categoryId: 1, goalId, effortMinutes: 240 })
      .expect(201);
    await patchTask(task.id, { deferredUntil: inOneHour() });

    const res = await draw(goalId);
    expect(res.task).toBeNull();
    expect(res.reason).toBe("all_too_big");
  });

  it("an expired snooze re-enters the pool with no write — deferred_until is retained as the wake time", async () => {
    const { goalId, task } = await seedGoalTask("expired-snooze");
    const past = oneHourAgo();
    await patchTask(task.id, { deferredUntil: past });

    const res = await draw(goalId);
    expect(res.task.id).toBe(task.id);
    expect(res.task.deferredUntil).toBe(past); // retained, not nulled (ADR-17)

    const row = db
      .prepare("SELECT deferred_until AS deferredUntil FROM tasks WHERE id = ?")
      .get(task.id) as { deferredUntil: string | null };
    expect(row.deferredUntil).toBe(past);
  });

  it("a blocked task stays out regardless of elapsed time until explicitly woken", async () => {
    const { goalId, task } = await seedGoalTask("blocked-forever");
    await patchTask(task.id, { blocked: true });
    // Even a card that has been lying around for a year is not drawn.
    db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(
      new Date(Date.now() - 365 * 24 * 3_600_000).toISOString(),
      task.id,
    );
    expect((await draw(goalId)).task).toBeNull();

    // Wake: deferredUntil = now (the wake timestamp), blocked off.
    await patchTask(task.id, { deferredUntil: new Date().toISOString(), blocked: false });
    expect((await draw(goalId)).task.id).toBe(task.id);
  });
});

describe("PATCH validation and serialization", () => {
  it("rejects invalid deferredUntil and blocked values with 400", async () => {
    const { task } = await seedGoalTask("validation");
    await patchTask(task.id, { deferredUntil: "not-a-date" }, 400);
    await patchTask(task.id, { deferredUntil: 123 }, 400);
    await patchTask(task.id, { deferredUntil: "" }, 400);
    await patchTask(task.id, { blocked: "yes" }, 400);
    await patchTask(task.id, { blocked: 1 }, 400);
  });

  it("normalizes deferredUntil to UTC ISO so the SQL string comparison holds", async () => {
    const { task } = await seedGoalTask("normalize");
    const res = await patchTask(task.id, { deferredUntil: "2099-07-20T10:00:00+02:00" });
    expect(res.task.deferredUntil).toBe("2099-07-20T08:00:00.000Z");
  });

  it("deferredUntil null stays valid as an explicit 'forget the snooze'", async () => {
    const { task } = await seedGoalTask("forget");
    await patchTask(task.id, { deferredUntil: inOneHour() });
    const res = await patchTask(task.id, { deferredUntil: null });
    expect(res.task.deferredUntil).toBeNull();
  });

  it("serializes blocked as a real boolean in every task payload", async () => {
    const { task } = await seedGoalTask("boolean");
    expect(task.blocked).toBe(false);
    const patched = await patchTask(task.id, { blocked: true });
    expect(patched.task.blocked).toBe(true);

    const list = await request(app).get("/api/tasks").expect(200);
    const listed = list.body.find((t: { id: number }) => t.id === task.id);
    expect(listed.blocked).toBe(true);
  });
});

describe("completion and reopening clear snooze state", () => {
  it("completing a snoozed+blocked task clears both fields", async () => {
    const { task } = await seedGoalTask("complete-clears");
    await patchTask(task.id, { deferredUntil: inOneHour(), blocked: true });

    const done = await patchTask(task.id, { status: "done" });
    expect(done.task.status).toBe("done");
    expect(done.task.deferredUntil).toBeNull();
    expect(done.task.blocked).toBe(false);
  });

  it("completing a recurring task clears both — what follows is the schedule, not a leftover snooze", async () => {
    const { goalId, task } = await seedGoalTask("recurring-clears", { recurEveryDays: 7 });
    await patchTask(task.id, { deferredUntil: inOneHour(), blocked: true });

    const done = await patchTask(task.id, { status: "done" });
    expect(done.recurring).toBe(true);
    expect(done.task.status).toBe("open");
    expect(done.task.deferredUntil).toBeNull();
    expect(done.task.blocked).toBe(false);

    // Out of the deck all the same — but derived from the new due date, not
    // from stored snooze state (#205, ADR-6 amended; before the fix the card
    // was re-dealt seconds after being finished).
    expect((await draw(goalId)).task).toBeNull();
    // The occurrence arriving puts it back with NO write, which is what
    // proves the cleared fields are really gone: a surviving snooze/block
    // would still be holding it out a week later.
    db.prepare("UPDATE tasks SET due_date = date('now') WHERE id = ?").run(task.id);
    expect((await draw(goalId)).task.id).toBe(task.id);
  });

  it("reopening a done task clears leftover snooze state", async () => {
    const { task } = await seedGoalTask("reopen-clears");
    await patchTask(task.id, { status: "done" });
    // Snooze state set while done (generic field map) must not survive reopen.
    await patchTask(task.id, { blocked: true, deferredUntil: inOneHour() });

    const reopened = await patchTask(task.id, { status: "open" });
    expect(reopened.task.deferredUntil).toBeNull();
    expect(reopened.task.blocked).toBe(false);
  });
});

describe("interaction with the persisted current draw (ADR-13)", () => {
  it("snoozing the current draw drops it from restore — and it stays dropped after waking", async () => {
    const { goalId, task } = await seedGoalTask("snooze-current");
    expect((await draw(goalId)).task.id).toBe(task.id);

    await patchTask(task.id, { deferredUntil: inOneHour() });
    expect((await request(app).get("/api/draw/current").expect(200)).body).toBeNull();

    // The pointer was cleared, not filtered: waking does not resurrect it.
    await patchTask(task.id, { deferredUntil: new Date().toISOString(), blocked: false });
    expect((await request(app).get("/api/draw/current").expect(200)).body).toBeNull();
  });

  it("blocking the current draw drops it from restore", async () => {
    const { goalId, task } = await seedGoalTask("block-current");
    expect((await draw(goalId)).task.id).toBe(task.id);

    await patchTask(task.id, { blocked: true });
    expect((await request(app).get("/api/draw/current").expect(200)).body).toBeNull();
  });

  // Regression: the pointer must be cleared eagerly by the PATCH itself, not
  // lazily by GET /api/draw/current — from the Tasks page the Draw page is
  // unmounted, so block → wake happens with NO GET in between, and a lazily
  // retained pointer would resurrect the dismissed card on the next visit.
  it("block then wake without any GET in between — the first restore attempt is null", async () => {
    const { goalId, task } = await seedGoalTask("block-wake-no-get");
    expect((await draw(goalId)).task.id).toBe(task.id);

    await patchTask(task.id, { blocked: true });
    await patchTask(task.id, { deferredUntil: new Date().toISOString(), blocked: false });
    // Task is back in the deck and restorable — only the eager clear keeps it out.
    expect((await request(app).get("/api/draw/current").expect(200)).body).toBeNull();
  });

  it("snoozing the current draw clears the pointer at PATCH time — an expiring snooze cannot resurrect it", async () => {
    const { goalId, task } = await seedGoalTask("snooze-expiry-no-get");
    expect((await draw(goalId)).task.id).toBe(task.id);

    await patchTask(task.id, { deferredUntil: inOneHour() });
    // The persisted pointer is already gone, without any GET having run.
    const pointer = db
      .prepare("SELECT value FROM settings WHERE key = 'current_draw_task_id'")
      .get();
    expect(pointer).toBeUndefined();

    // Simulate the snooze wearing off before the next Draw-page visit.
    db.prepare("UPDATE tasks SET deferred_until = ? WHERE id = ?").run(oneHourAgo(), task.id);
    expect((await request(app).get("/api/draw/current").expect(200)).body).toBeNull();
  });

  it("keeps the pointer when a snooze/block PATCH leaves the draw in the deck", async () => {
    const { goalId, task } = await seedGoalTask("noop-patch-keeps");
    expect((await draw(goalId)).task.id).toBe(task.id);

    // blocked: false on a never-blocked card dismisses nothing.
    await patchTask(task.id, { blocked: false });
    const restored = await request(app).get("/api/draw/current").expect(200);
    expect(restored.body.task.id).toBe(task.id);
  });
});
