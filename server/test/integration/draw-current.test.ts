import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import type Database from "better-sqlite3";
import { freshApp, testDb } from "../helpers.js";

// Issue #25: the current draw is persisted server-side so a reload restores
// the card. Each test draws from its own goal-scoped pool of exactly one
// task, so the roulette pick is deterministic.

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

async function current() {
  return (await request(app).get("/api/draw/current").expect(200)).body;
}

describe("current draw lifecycle", () => {
  it("POST /api/draw persists the pick; GET /api/draw/current returns it", async () => {
    const { goalId, task } = await seedGoalTask("persist");
    const drawn = await draw(goalId);
    expect(drawn.task.id).toBe(task.id);

    const cur = await current();
    expect(cur.task.id).toBe(task.id);
    expect(cur.task.title).toBe("persist task");
    // Restore carries the task only — the original odds are not persisted.
    expect(cur.probability).toBeUndefined();
    expect(cur.poolSize).toBeUndefined();
  });

  it("a new draw replaces the current one", async () => {
    const a = await seedGoalTask("replace-a");
    const b = await seedGoalTask("replace-b");
    await draw(a.goalId);
    await draw(b.goalId);
    expect((await current()).task.id).toBe(b.task.id);
  });

  it("an empty draw clears the current one (the card visibly left the screen)", async () => {
    const { goalId } = await seedGoalTask("empty-clears");
    await draw(goalId);
    const emptyGoal = (
      await request(app).post("/api/goals").send({ title: "no tasks here" }).expect(201)
    ).body;
    const res = await draw(emptyGoal.id);
    expect(res.task).toBeNull();
    expect(await current()).toBeNull();
  });

  it("completing the current draw clears it and pays the drawn bonus without any client flag", async () => {
    const { goalId, task } = await seedGoalTask("complete", { effortMinutes: 20 });
    await draw(goalId);

    const done = (
      await request(app).patch(`/api/tasks/${task.id}`).send({ status: "done" }).expect(200)
    ).body;
    expect(done.xpAwarded).toBe(30); // 20 × (3/3) × 1.5 — bonus derived server-side

    const row = db
      .prepare("SELECT was_drawn AS wasDrawn FROM completions WHERE task_id = ?")
      .get(task.id) as { wasDrawn: number };
    expect(row.wasDrawn).toBe(1);
    expect(await current()).toBeNull();
  });

  it("the drawn bonus survives past the 6h heuristic — the reload-next-day case", async () => {
    const { goalId, task } = await seedGoalTask("stale-draw", { effortMinutes: 20 });
    await draw(goalId);
    const tenHoursAgo = new Date(Date.now() - 10 * 3_600_000).toISOString();
    db.prepare("UPDATE tasks SET last_drawn_at = ? WHERE id = ?").run(tenHoursAgo, task.id);

    const done = (
      await request(app).patch(`/api/tasks/${task.id}`).send({ status: "done" }).expect(200)
    ).body;
    expect(done.xpAwarded).toBe(30);
  });

  it("ignores a client wasDrawn flag on a never-drawn task", async () => {
    const { task } = await seedGoalTask("no-trust", { effortMinutes: 20 });
    const done = (
      await request(app)
        .patch(`/api/tasks/${task.id}`)
        .send({ status: "done", wasDrawn: true })
        .expect(200)
    ).body;
    expect(done.xpAwarded).toBe(20); // no bonus — the flag is not trusted
  });

  it("completing a recurring current draw clears it although the task stays open", async () => {
    const { goalId, task } = await seedGoalTask("recurring", { recurEveryDays: 7 });
    await draw(goalId);
    const done = (
      await request(app).patch(`/api/tasks/${task.id}`).send({ status: "done" }).expect(200)
    ).body;
    expect(done.recurring).toBe(true);
    expect(await current()).toBeNull();
  });

  it("completing a different task leaves the current draw alone", async () => {
    const drawnSide = await seedGoalTask("kept");
    const otherSide = await seedGoalTask("bystander");
    await draw(drawnSide.goalId);
    await request(app)
      .patch(`/api/tasks/${otherSide.task.id}`)
      .send({ status: "done" })
      .expect(200);
    expect((await current()).task.id).toBe(drawnSide.task.id);
  });

  it("deleting the drawn task clears the current draw", async () => {
    const { goalId, task } = await seedGoalTask("delete");
    await draw(goalId);
    await request(app).delete(`/api/tasks/${task.id}`).expect(200);
    expect(await current()).toBeNull();
  });

  it("deleting the drawn subtask's parent clears the draw — a capture reusing the id is not restored", async () => {
    const { goalId, task: parent } = await seedGoalTask("cascade");
    const [sub] = (
      await request(app)
        .post(`/api/tasks/${parent.id}/subtasks`)
        .send({ subtasks: [{ title: "cascade sub", effortMinutes: 10 }] })
        .expect(201)
    ).body;
    // The parent has an open child now, so the goal pool is exactly the sub.
    expect((await draw(goalId)).task.id).toBe(sub.id);

    // Deleting the PARENT cascade-deletes the drawn subtask.
    await request(app).delete(`/api/tasks/${parent.id}`).expect(200);

    // No GET /api/draw/current runs in between (the query is inactive while
    // the DrawPage is unmounted) — and without AUTOINCREMENT, SQLite hands
    // the freed ids back to the next captures: parent's first, then sub's.
    await request(app)
      .post("/api/tasks")
      .send({ title: "captured after 1", categoryId: 1, effortMinutes: 10 })
      .expect(201);
    const reborn = (
      await request(app)
        .post("/api/tasks")
        .send({ title: "captured after 2", categoryId: 1, effortMinutes: 10 })
        .expect(201)
    ).body;
    expect(reborn.id).toBe(sub.id); // the drawn task's id really was re-bound

    // The never-drawn newcomer must not come back as the current draw...
    expect(await current()).toBeNull();
    // ...and completing it pays plain XP, not the drawn bonus.
    const done = (
      await request(app).patch(`/api/tasks/${reborn.id}`).send({ status: "done" }).expect(200)
    ).body;
    expect(done.xpAwarded).toBe(10); // 10 × (3/3), no ×1.5
  });

  it("a draw edited out of the deck is dropped on restore — and stays dropped", async () => {
    const { goalId, task } = await seedGoalTask("too-big");
    await draw(goalId);
    await request(app).patch(`/api/tasks/${task.id}`).send({ effortMinutes: 999 }).expect(200);
    expect(await current()).toBeNull();

    // The pointer was cleared, not just filtered: shrinking the task back
    // does not resurrect the old draw.
    await request(app).patch(`/api/tasks/${task.id}`).send({ effortMinutes: 10 }).expect(200);
    expect(await current()).toBeNull();
  });

  it("a draw that became a container (open subtask added) is not restored", async () => {
    const { goalId, task } = await seedGoalTask("container");
    await draw(goalId);
    await request(app)
      .post(`/api/tasks/${task.id}/subtasks`)
      .send({ subtasks: [{ title: "sub", effortMinutes: 5 }] })
      .expect(201);
    expect(await current()).toBeNull();
  });

  it("never leaks the pointer through GET /api/settings", async () => {
    const { goalId } = await seedGoalTask("no-leak");
    await draw(goalId);
    const settings = (await request(app).get("/api/settings").expect(200)).body;
    expect(settings).not.toHaveProperty("current_draw_task_id");
  });

  it("carries trackedMinutes (DEF, #115) — CLOSED entries only, derived at query time", async () => {
    const { goalId, task } = await seedGoalTask("def-stat");

    // 25.9 closed minutes across three entries, plus a RUNNING entry that
    // must NOT count: the client adds the running entry's elapsed itself
    // (the live DEF tick), so counting it here would double it. The .9
    // fraction pins the fold to FLOOR (PR #120 review): the live tick floors,
    // so ROUND-ing here would bump DEF from 25 to 26 the moment the timer
    // stops.
    const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
    const entry = db.prepare(
      "INSERT INTO time_entries (task_id, started_at, ended_at) VALUES (?, ?, ?)",
    );
    entry.run(task.id, minsAgo(120), minsAgo(110)); // 10 min
    entry.run(task.id, minsAgo(60), minsAgo(45)); // 15 min
    entry.run(task.id, minsAgo(40), minsAgo(39.1)); // 0.9 min — floored away
    entry.run(task.id, minsAgo(30), null); // running — excluded

    const drawn = await draw(goalId);
    expect(drawn.task.trackedMinutes).toBe(25);

    // The restore payload derives the same number (ADR-13: one card, one truth).
    expect((await current()).task.trackedMinutes).toBe(25);

    // A card that was never fought reads 0, not null — DEF always renders.
    const fresh = await seedGoalTask("def-zero");
    expect((await draw(fresh.goalId)).task.trackedMinutes).toBe(0);
  });
});
