import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import type Database from "better-sqlite3";
import { freshApp, testDb } from "../helpers.js";
import {
  completionGoldForXp,
  totalGold,
} from "../../src/services/gamificationService.js";
import { localDate } from "../../src/services/localDay.js";

let app: express.Express;
let db: Database.Database;
let baselineGold = 0;

beforeAll(async () => {
  app = await freshApp();
  db = await testDb();
});

beforeEach(() => {
  db.prepare("DROP TRIGGER IF EXISTS test_completion_owner_failure").run();
  db.prepare("DELETE FROM tasks").run();
  db.prepare("DELETE FROM achievements").run();
  // The ledger is append-only in tests too; compare each case from the total
  // it inherited instead of adding a test-only repair/delete path.
  baselineGold = totalGold();
});

async function createTask(
  title: string,
  extra: Record<string, unknown> = {},
): Promise<{ id: number }> {
  return (
    await request(app)
      .post("/api/tasks")
      .send({ title, categoryId: 1, effortMinutes: 10, ...extra })
      .expect(201)
  ).body;
}

async function complete(id: number) {
  return request(app).patch(`/api/tasks/${id}`).send({ status: "done" }).expect(200);
}

describe("completion Gold formula and owner", () => {
  it("uses JavaScript round ties and the one-Gold floor for the approved fixtures", () => {
    expect([1, 4, 5, 14, 15, 24, 25].map(completionGoldForXp)).toEqual([1, 1, 1, 1, 2, 2, 3]);
  });

  it("stamps ordinary XP and Gold in one row and exposes aggregate/server card truth", async () => {
    const task = await createTask("ordinary", { effortMinutes: 15 });
    const res = await complete(task.id);
    expect(res.body).toMatchObject({ xpAwarded: 15, goldAwarded: 2 });

    expect(
      db
        .prepare("SELECT xp_awarded AS xpAwarded, gold_awarded AS goldAwarded FROM completions WHERE task_id = ?")
        .get(task.id),
    ).toEqual({ xpAwarded: 15, goldAwarded: 2 });

    const g = (await request(app).get("/api/gamification").expect(200)).body;
    expect(g.totalGold).toBe(baselineGold + 2);
    expect(g.todayCompletions.find((c: { taskId: number }) => c.taskId === task.id)).toMatchObject({
      xpAwarded: 15,
      goldAwarded: 2,
    });
    const day = localDate(new Date());
    const activity = (await request(app).get(`/api/activity?from=${day}&to=${day}`).expect(200)).body;
    expect(activity.days[0].cards.find((c: { taskId: number }) => c.taskId === task.id)).toMatchObject({
      completed: true,
      xpAwarded: 15,
      goldAwarded: 2,
    });
  });

  it("uses final drawn XP and pays each recurring occurrence", async () => {
    const drawn = await createTask("drawn", { effortMinutes: 10 });
    db.prepare("UPDATE tasks SET last_drawn_at = ? WHERE id = ?").run(new Date().toISOString(), drawn.id);
    expect((await complete(drawn.id)).body).toMatchObject({ xpAwarded: 15, goldAwarded: 2 });

    const recurring = await createTask("recurring", { effortMinutes: 10, recurEveryDays: 1 });
    expect((await complete(recurring.id)).body).toMatchObject({
      xpAwarded: 10,
      goldAwarded: 1,
      recurring: true,
    });
    expect((await complete(recurring.id)).body).toMatchObject({
      xpAwarded: 10,
      goldAwarded: 1,
      recurring: true,
    });
    expect(
      db.prepare("SELECT SUM(gold_awarded) AS gold FROM completions WHERE task_id = ?").get(recurring.id),
    ).toEqual({ gold: 2 });
  });

  it("removes only the latest owner on reopen, replaces it on recompletion, and cascades on delete", async () => {
    const task = await createTask("lifecycle");
    await complete(task.id);
    expect(totalGold()).toBe(baselineGold + 1);

    const reopened = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({ status: "open" })
      .expect(200);
    expect(reopened.body).not.toHaveProperty("goldAwarded");
    expect(totalGold()).toBe(baselineGold);

    await complete(task.id);
    expect(totalGold()).toBe(baselineGold + 1);
    const deleted = await request(app).delete(`/api/tasks/${task.id}`).expect(200);
    expect(deleted.body).not.toHaveProperty("goldAwarded");
    expect(totalGold()).toBe(baselineGold);
  });

  it("keeps legacy completion Gold at zero and leaves the derived total unclamped", async () => {
    const task = await createTask("legacy");
    db.prepare(
      "INSERT INTO completions (task_id, completed_at, xp_awarded) VALUES (?, ?, ?)",
    ).run(task.id, new Date().toISOString(), 100);
    db.prepare(
      "INSERT INTO gold_ledger (amount, reason, ref, created_at) VALUES (-3, 'purchase', 'negative-test', ?)",
    ).run(new Date().toISOString());

    expect(totalGold()).toBe(baselineGold - 3);
    const g = (await request(app).get("/api/gamification").expect(200)).body;
    expect(g.totalGold).toBe(baselineGold - 3);
    expect(g.todayCompletions.find((c: { taskId: number }) => c.taskId === task.id).goldAwarded).toBe(0);
  });

  it("rolls back the task and timer mutation when the completion owner insert fails", async () => {
    const task = await createTask("owner failure");
    await request(app).post(`/api/tasks/${task.id}/timer/start`).expect(200);
    db.exec(`CREATE TRIGGER test_completion_owner_failure
      BEFORE INSERT ON completions BEGIN
        SELECT RAISE(ABORT, 'forced completion owner failure');
      END`);

    await request(app).patch(`/api/tasks/${task.id}`).send({ status: "done" }).expect(500);
    const row = db
      .prepare("SELECT status, completed_at AS completedAt FROM tasks WHERE id = ?")
      .get(task.id);
    expect(row).toEqual({ status: "open", completedAt: null });
    expect(db.prepare("SELECT COUNT(*) AS n FROM completions WHERE task_id = ?").get(task.id)).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM time_entries WHERE task_id = ? AND ended_at IS NULL").get(task.id)).toEqual({ n: 1 });
    expect(totalGold()).toBe(baselineGold);
  });
});
