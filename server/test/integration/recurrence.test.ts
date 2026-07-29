import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import type Database from "better-sqlite3";
import { freshApp, testDb } from "../helpers.js";

// Issue #205 (ADR-6 amended): a recurring task's due_date is its NEXT
// OCCURRENCE — the card is out of the deck until that day, and completing it
// schedules the one after. Before the fix, completing a chore left it
// immediately drawable and the deck re-dealt the card the user had just
// finished.
//
// Each test draws from its OWN goal-scoped pool (the draw-current.test.ts
// pattern) so the roulette pick is deterministic. The clock is never slept
// on: occurrences are moved by seeding due dates, which is exactly what the
// user's calendar does over the following days.

let app: express.Express;
let db: Database.Database;

beforeAll(async () => {
  app = await freshApp();
  db = await testDb();
});

// The user's calendar day, the clock the schedule is written and read in
// (PR #206 review) — the suite runs pinned to Europe/Berlin, so these differ
// from the UTC day for two hours every night.
function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function daysFromNow(n: number): string {
  const d = new Date(`${today()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function seedGoal(title: string): Promise<number> {
  return (await request(app).post("/api/goals").send({ title }).expect(201)).body.id;
}

async function seedTask(goalId: number, task: Record<string, unknown>) {
  return (
    await request(app)
      .post("/api/tasks")
      .send({ categoryId: 1, effortMinutes: 15, goalId, ...task })
      .expect(201)
  ).body;
}

async function draw(goalId: number) {
  return (await request(app).post("/api/draw").send({ goalId }).expect(200)).body;
}

async function complete(id: number) {
  return (await request(app).patch(`/api/tasks/${id}`).send({ status: "done" }).expect(200)).body;
}

function stored(id: number) {
  return db
    .prepare(
      "SELECT status, due_date AS dueDate, deferred_until AS deferredUntil, blocked FROM tasks WHERE id = ?",
    )
    .get(id) as {
    status: string;
    dueDate: string | null;
    deferredUntil: string | null;
    blocked: number;
  };
}

describe("the #205 reproduction: a completed chore sleeps until its next occurrence", () => {
  it("is not re-dealt right after completion, and returns once the occurrence arrives", async () => {
    const goalId = await seedGoal("buero");
    const task = await seedTask(goalId, {
      title: "Buero",
      effortMinutes: 15,
      dueDate: daysFromNow(4),
      recurEveryDays: 4,
    });

    // Its FIRST occurrence is four days out, so it is not in the deck yet.
    const before = await draw(goalId);
    expect(before.task).toBeNull();
    expect(before.reason).toBe("all_awaiting_next_occurrence");

    // Completing it anyway (the Tasks page always allows that) schedules the
    // next occurrence: the task stays open, the due date advances, and NO
    // snooze state is invented for the sleep (ADR-2 — it is derived).
    const done = await complete(task.id);
    expect(done.recurring).toBe(true);
    expect(done.task.status).toBe("open");
    expect(done.task.dueDate).toBe(daysFromNow(4));
    expect(done.task.deferredUntil).toBeNull();
    expect(done.task.blocked).toBe(false);

    // The bug: ten draws in a row used to hand back the card just finished.
    for (let i = 0; i < 10; i++) {
      const res = await draw(goalId);
      expect(res.task).toBeNull();
      // Honest reason: it comes back on its own — nothing to break down.
      expect(res.reason).toBe("all_awaiting_next_occurrence");
    }
    expect((await request(app).get("/api/draw/pool").expect(200)).body.candidates).toEqual([]);

    // Four days later — seeded, not slept — the occurrence has arrived.
    db.prepare("UPDATE tasks SET due_date = ? WHERE id = ?").run(today(), task.id);
    expect((await draw(goalId)).task.id).toBe(task.id);

    // And a missed occurrence does not disappear: an overdue chore stays in
    // the deck (and keeps its ×5 urgency).
    db.prepare("UPDATE tasks SET due_date = ? WHERE id = ?").run(daysFromNow(-3), task.id);
    expect((await draw(goalId)).task.id).toBe(task.id);
  });

  it("stores the sleep nowhere: the next occurrence is the due date, in one clock", async () => {
    const goalId = await seedGoal("one clock");
    const task = await seedTask(goalId, { title: "Wipe counters", recurEveryDays: 3 });

    const done = await complete(task.id);
    const row = stored(task.id);
    expect(row.status).toBe("open");
    expect(row.dueDate).toBe(daysFromNow(3));
    expect(row.dueDate).toBe(done.task.dueDate);
    expect(row.deferredUntil).toBeNull(); // no hidden snooze row (ADR-17)
    expect(row.blocked).toBe(0);
    expect((await draw(goalId)).task).toBeNull();
  });

  it("clears a manual snooze on completion — it must not outlive the cycle it was about", async () => {
    const goalId = await seedGoal("snooze then complete");
    const task = await seedTask(goalId, { title: "Snoozed chore", recurEveryDays: 2 });
    await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({ deferredUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(), blocked: true })
      .expect(200);

    const done = await complete(task.id);
    expect(done.task.deferredUntil).toBeNull();
    expect(done.task.blocked).toBe(false);

    // The schedule alone decides when it comes back: asleep for two days…
    expect((await draw(goalId)).task).toBeNull();
    // …not for the thirty the stale snooze would have added.
    db.prepare("UPDATE tasks SET due_date = ? WHERE id = ?").run(today(), task.id);
    expect((await draw(goalId)).task.id).toBe(task.id);
  });
});

describe("the gate applies to recurring tasks only", () => {
  it("keeps a NON-recurring task with a future due date fully drawable", async () => {
    const goalId = await seedGoal("not yet due");
    const task = await seedTask(goalId, {
      title: "Tax return",
      dueDate: daysFromNow(30),
    });
    expect((await draw(goalId)).task.id).toBe(task.id);
  });

  it("keeps a recurring task WITHOUT a due date always drawable", async () => {
    const goalId = await seedGoal("no schedule");
    const task = await seedTask(goalId, { title: "Stretch", recurEveryDays: 1 });
    expect((await draw(goalId)).task.id).toBe(task.id);
  });

  it("draws a recurring task on the day of its occurrence (boundary)", async () => {
    const goalId = await seedGoal("due today");
    const task = await seedTask(goalId, {
      title: "Water plants",
      dueDate: today(),
      recurEveryDays: 7,
    });
    expect((await draw(goalId)).task.id).toBe(task.id);
  });
});

describe("empty-pool reasons stay honest", () => {
  it("prefers the actionable reason when an oversized card is also in the pool", async () => {
    const goalId = await seedGoal("mixed sleeping");
    // A sleeping chore takes precedence over the anyOpen dispatch, exactly
    // like an out-of-window card (#33): both return on their own.
    await seedTask(goalId, { title: "Sleeping chore", dueDate: daysFromNow(2), recurEveryDays: 2 });
    await seedTask(goalId, { title: "Huge job", effortMinutes: 240 });
    expect((await draw(goalId)).reason).toBe("all_awaiting_next_occurrence");
  });

  it("stays all_too_big when the sleeping chore is ALSO oversized — waiting will not fix that", async () => {
    const goalId = await seedGoal("oversized sleeping");
    await seedTask(goalId, {
      title: "Oversized chore",
      effortMinutes: 240,
      dueDate: daysFromNow(2),
      recurEveryDays: 2,
    });
    expect((await draw(goalId)).reason).toBe("all_too_big");
  });

  it("reports no_ready_tasks when the goal has nothing open at all", async () => {
    const goalId = await seedGoal("nothing here");
    expect((await draw(goalId)).reason).toBe("no_ready_tasks");
  });
});

// The schedule compares due dates as STRINGS, which makes their format
// load-bearing (PR #206 review): "2026-7-4" sorts after "2026-07-26", so an
// unpadded date would park a recurring card outside the deck for centuries
// while POST /api/draw promises it comes back on its own.
describe("due dates must be real YYYY-MM-DD days", () => {
  const post = (body: Record<string, unknown>) =>
    request(app).post("/api/tasks").send({ title: "date shape", categoryId: 1, ...body });

  it("rejects an unpadded date over REST instead of storing an unorderable string", async () => {
    const res = await post({ dueDate: "2026-7-4", recurEveryDays: 4 }).expect(400);
    expect(res.body.error).toContain("dueDate");
  });

  it("rejects malformed and impossible dates", async () => {
    for (const dueDate of ["2026-02-30", "2026-13-01", "26-07-04", "2026/07/04", "next friday", ""]) {
      const res = await post({ dueDate }).expect(400);
      expect(res.body.error).toContain("dueDate");
    }
  });

  it("still accepts a well-formed date, and null to clear it", async () => {
    const created = (await post({ dueDate: "2026-07-04" }).expect(201)).body;
    expect(created.dueDate).toBe("2026-07-04");
    const cleared = await request(app)
      .patch(`/api/tasks/${created.id}`)
      .send({ dueDate: null })
      .expect(200);
    expect(cleared.body.task.dueDate).toBeNull();
  });

  it("rejects the same shapes on PATCH — an edit cannot smuggle one in", async () => {
    const created = (await post({ dueDate: "2026-07-04" }).expect(201)).body;
    await request(app).patch(`/api/tasks/${created.id}`).send({ dueDate: "2026-7-4" }).expect(400);
    expect(stored(created.id).dueDate).toBe("2026-07-04");
  });
});

describe("interaction with the persisted current draw (ADR-13) and staleness (ADR-17)", () => {
  it("clears the pointer on completion and does not restore the sleeping card", async () => {
    const goalId = await seedGoal("current draw");
    const task = await seedTask(goalId, { title: "Recurring current", recurEveryDays: 5 });
    expect((await draw(goalId)).task.id).toBe(task.id);

    await complete(task.id);
    expect((await request(app).get("/api/draw/current").expect(200)).body).toBeNull();

    // Even with the pointer forced back, restore validation rejects a card
    // that is sleeping until its next occurrence.
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('current_draw_task_id', ?)",
    ).run(String(task.id));
    expect((await request(app).get("/api/draw/current").expect(200)).body).toBeNull();
  });

  // Regression for the EAGER clear (ADR-17's wear-off argument, extended to
  // the schedule): the pointer must be dropped by the PATCH itself, not by
  // GET /api/draw/current's lazy validation — the occurrence arriving is a
  // wear-off with no write, so a retained pointer would resurrect the card
  // days later with no GET in between. Asserted on the settings row, because
  // any GET here would hide the difference (the lazy path clears it too).
  it("scheduling the drawn card into a future occurrence clears the pointer at PATCH time", async () => {
    const goalId = await seedGoal("scheduled away");
    const task = await seedTask(goalId, { title: "Becomes recurring", recurEveryDays: 3 });
    expect((await draw(goalId)).task.id).toBe(task.id);

    await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({ dueDate: daysFromNow(3) })
      .expect(200);
    expect(
      db.prepare("SELECT value FROM settings WHERE key = 'current_draw_task_id'").get(),
    ).toBeUndefined();

    // Simulate the occurrence arriving before the next Draw-page visit: the
    // card is drawable again, but the dismissed pointer stays dismissed.
    db.prepare("UPDATE tasks SET due_date = ? WHERE id = ?").run(today(), task.id);
    expect((await request(app).get("/api/draw/current").expect(200)).body).toBeNull();
  });

  it("clears the pointer the same way when a due-dated card BECOMES recurring", async () => {
    const goalId = await seedGoal("becomes recurring");
    const task = await seedTask(goalId, { title: "Gains a recurrence", dueDate: daysFromNow(5) });
    // Non-recurring with a future due date: still drawable, still the draw.
    expect((await draw(goalId)).task.id).toBe(task.id);

    await request(app).patch(`/api/tasks/${task.id}`).send({ recurEveryDays: 5 }).expect(200);
    expect(
      db.prepare("SELECT value FROM settings WHERE key = 'current_draw_task_id'").get(),
    ).toBeUndefined();
  });

  it("counts staleness from the last completion, not from a wake time the fix no longer writes", async () => {
    const goalId = await seedGoal("staleness anchor");
    const task = await seedTask(goalId, { title: "Anchor chore", recurEveryDays: 1 });
    await complete(task.id);
    // Back in the deck the next day…
    db.prepare("UPDATE tasks SET due_date = ? WHERE id = ?").run(today(), task.id);
    expect((await draw(goalId)).task.id).toBe(task.id);
    // …with deferred_until still untouched, so stalenessAnchor falls back to
    // the completion (drawService.stalenessAnchor, pinned in draw-weights).
    expect(stored(task.id).deferredUntil).toBeNull();
  });
});
