import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import type Database from "better-sqlite3";
import { freshApp, testDb } from "../helpers.js";

// Issue #108: split-in-place — POST /api/tasks/:id/split replaces an open,
// non-recurring subtask with >= 2 parts as siblings at the same level, in one
// transaction; the original ends archived (never deleted — its time entries
// and completions survive) and falls out of every derived surface with no
// write (ADR-2/8.1). Parts adopt the original's created_at verbatim, so under
// a sequential parent they occupy its queue slot (ADR-18 amendment). Each
// test draws from its own goal-scoped pool, like sequential-subtasks.test.ts.

let app: express.Express;
let db: Database.Database;

beforeAll(async () => {
  app = await freshApp();
  db = await testDb();
});

async function seedGoalParent(
  title: string,
  parentOverrides: Record<string, unknown> = {},
): Promise<{ goalId: number; parent: Record<string, any> }> {
  const goal = (await request(app).post("/api/goals").send({ title }).expect(201)).body;
  const parent = (
    await request(app)
      .post("/api/tasks")
      .send({ title: `${title} parent`, categoryId: 1, goalId: goal.id, ...parentOverrides })
      .expect(201)
  ).body;
  return { goalId: goal.id, parent };
}

async function addSubtasks(
  parentId: number,
  subtasks: Record<string, unknown>[],
  orderMode?: string,
) {
  return (
    await request(app)
      .post(`/api/tasks/${parentId}/subtasks`)
      .send(orderMode === undefined ? { subtasks } : { subtasks, orderMode })
      .expect(201)
  ).body;
}

async function split(id: number, parts: unknown, status = 201) {
  return (await request(app).post(`/api/tasks/${id}/split`).send({ parts }).expect(status)).body;
}

async function draw(goalId: number) {
  return (await request(app).post("/api/draw").send({ goalId }).expect(200)).body;
}

async function listedTask(id: number) {
  const list = (await request(app).get("/api/tasks").expect(200)).body;
  for (const root of list) {
    if (root.id === id) return root;
    const sub = (root.subtasks ?? []).find((s: { id: number }) => s.id === id);
    if (sub) return sub;
  }
  return undefined;
}

/** Distinct, ordered created_at values — the timestamp-distinct sibling case. */
function backdate(ids: number[], startMsAgo = 3_600_000) {
  const base = Date.now() - startMsAgo;
  ids.forEach((id, i) => {
    db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(
      new Date(base + i * 60_000).toISOString(),
      id,
    );
  });
}

const TWO_PARTS = [
  { title: "split part 1", effortMinutes: 25 },
  { title: "split part 2", effortMinutes: 20 },
];

describe("the split transaction", () => {
  it("creates the parts under the same parent and archives the original — time entries intact", async () => {
    const { parent } = await seedGoalParent("split-happy");
    const [original] = await addSubtasks(parent.id, [
      { title: "too big step", effortMinutes: 45 },
    ]);
    // Tracked minutes on the original must survive the split (the keep-as-
    // archived rationale: delete would cascade them away, ADR-21).
    db.prepare(
      "INSERT INTO time_entries (task_id, started_at, ended_at) VALUES (?, ?, ?)",
    ).run(original.id, new Date(Date.now() - 600_000).toISOString(), new Date().toISOString());

    const parts = await split(original.id, [
      { title: "first half", effortMinutes: 25, description: "kept provenance" },
      { title: "second half", effortMinutes: 20 },
    ]);

    expect(parts.map((p: any) => [p.title, p.effortMinutes, p.parentId])).toEqual([
      ["first half", 25, parent.id],
      ["second half", 20, parent.id],
    ]);
    expect(parts[0].description).toBe("kept provenance");

    // Original: archived, not deleted, not done — with its entry intact.
    const row = db
      .prepare("SELECT status, completed_at AS completedAt FROM tasks WHERE id = ?")
      .get(original.id) as { status: string; completedAt: string | null };
    expect(row.status).toBe("archived");
    expect(row.completedAt).toBeNull();
    const entries = db
      .prepare("SELECT COUNT(*) AS n FROM time_entries WHERE task_id = ?")
      .get(original.id) as { n: number };
    expect(entries.n).toBe(1);
  });

  it("writes nothing when a part mid-list is invalid — whole-body validation before the transaction", async () => {
    const { parent } = await seedGoalParent("split-atomic");
    const [original] = await addSubtasks(parent.id, [{ title: "atomic step", effortMinutes: 45 }]);

    const res = await request(app)
      .post(`/api/tasks/${original.id}/split`)
      .send({
        parts: [
          { title: "fine", effortMinutes: 20 },
          { title: "broken", effortMinutes: -5 },
          { title: "never judged", effortMinutes: 20 },
        ],
      })
      .expect(400);
    expect(res.body.error).toMatch(/positive integer/);

    expect((await listedTask(original.id)).status).toBe("open");
    expect((await listedTask(parent.id)).subtasks.map((s: any) => s.title)).toEqual([
      "atomic step",
    ]);
  });

  it("closes a running time entry on the original at split time (ADR-12 mirror)", async () => {
    const { parent } = await seedGoalParent("split-timer");
    const [original] = await addSubtasks(parent.id, [{ title: "timed step", effortMinutes: 45 }]);
    await request(app).post(`/api/tasks/${original.id}/timer/start`).expect(200);
    expect((await request(app).get("/api/timer/current").expect(200)).body?.entry?.taskId).toBe(
      original.id,
    );

    await split(original.id, TWO_PARTS);

    expect((await request(app).get("/api/timer/current").expect(200)).body).toBeNull();
    const entry = db
      .prepare("SELECT ended_at AS endedAt FROM time_entries WHERE task_id = ?")
      .get(original.id) as { endedAt: string | null };
    expect(entry.endedAt).not.toBeNull();
  });

  it("clears the current-draw pointer when the split original was the persisted draw", async () => {
    const { goalId, parent } = await seedGoalParent("split-drawn");
    // Drawable-sized — the endpoint has no size gate, an API caller can
    // split the persisted draw. The goal-scoped pool holds exactly this card.
    const [original] = await addSubtasks(parent.id, [{ title: "drawn step", effortMinutes: 10 }]);
    expect((await draw(goalId)).task.id).toBe(original.id);

    await split(original.id, TWO_PARTS);

    // No resurrectable pointer — cleared eagerly, not left to lazy validation.
    expect(db.prepare("SELECT value FROM settings WHERE key = 'current_draw_task_id'").get()).toBeUndefined();
    expect((await request(app).get("/api/draw/current").expect(200)).body).toBeNull();
  });
});

describe("inheritance matrix", () => {
  it("parts take category/goal from the parent, impact/dueDate/window from the original, and start fresh", async () => {
    const { goalId, parent } = await seedGoalParent("split-inherit");
    const [original] = await addSubtasks(parent.id, [
      { title: "inherit source", effortMinutes: 45, impact: 5 },
    ]);
    await request(app)
      .patch(`/api/tasks/${original.id}`)
      .send({
        dueDate: "2026-08-01",
        windowDays: [1, 3],
        windowStart: "08:00",
        windowEnd: "12:00",
        // Snoozed AND blocked — parts must inherit neither.
        deferredUntil: new Date(Date.now() + 3_600_000).toISOString(),
        blocked: true,
      })
      .expect(200);
    // The original's category diverging from the parent's (editable per #38)
    // does not travel to the parts — they restart from the parent, like the
    // batch endpoint by construction.
    db.prepare("UPDATE tasks SET category_id = 2, last_drawn_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      original.id,
    );

    const parts = await split(original.id, TWO_PARTS);

    for (const part of parts) {
      expect(part.categoryId).toBe(parent.categoryId);
      expect(part.goalId).toBe(goalId);
      expect(part.impact).toBe(5);
      expect(part.dueDate).toBe("2026-08-01");
      expect(part.windowDays).toEqual([1, 3]);
      expect(part.windowStart).toBe("08:00");
      expect(part.windowEnd).toBe("12:00");
      expect(part.deferredUntil).toBeNull();
      expect(part.blocked).toBe(false);
      expect(part.lastDrawnAt).toBeNull();
      expect(part.recurEveryDays).toBeNull();
    }
  });

  it("parts adopt the original's created_at verbatim, staying in array order via the id tie-break", async () => {
    const { parent } = await seedGoalParent("split-created-at");
    const [original] = await addSubtasks(parent.id, [{ title: "old step", effortMinutes: 45 }]);
    backdate([original.id]);
    const createdAt = (
      db.prepare("SELECT created_at AS c FROM tasks WHERE id = ?").get(original.id) as { c: string }
    ).c;

    const parts = await split(original.id, TWO_PARTS);
    expect(parts.map((p: any) => p.createdAt)).toEqual([createdAt, createdAt]);
    expect(parts[0].id).toBeLessThan(parts[1].id);
    // The child list renders them in the original's slot, in array order.
    const listed = (await listedTask(parent.id)).subtasks.map((s: any) => s.title);
    expect(listed).toEqual(["split part 1", "split part 2"]);
  });
});

describe("queue position under a sequential parent (ADR-18 amendment)", () => {
  it("parts occupy the original's slot: first part exposed, rest held back, later siblings behind them", async () => {
    const { goalId, parent } = await seedGoalParent("split-queue");
    const [stepA, stepB, stepC] = await addSubtasks(
      parent.id,
      [
        { title: "queue A", effortMinutes: 5 },
        { title: "queue B", effortMinutes: 45 },
        { title: "queue C", effortMinutes: 5 },
      ],
      "sequential",
    );
    // Timestamp-distinct siblings — the exact-placement case.
    backdate([stepA.id, stepB.id, stepC.id]);

    await request(app).patch(`/api/tasks/${stepA.id}`).send({ status: "done" }).expect(200);
    const [part1, part2] = await split(stepB.id, TWO_PARTS);

    // The first part is exposed exactly where B was; part 2 and the
    // later-timestamp C queue behind it, in that order.
    expect((await listedTask(part1.id)).heldBack).toBe(0);
    expect((await listedTask(part2.id)).heldBack).toBe(1);
    expect((await listedTask(stepC.id)).heldBack).toBe(1);
    for (let i = 0; i < 5; i++) {
      expect((await draw(goalId)).task.id).toBe(part1.id);
    }

    // Completing the parts in order walks the queue: part2, then C.
    await request(app).patch(`/api/tasks/${part1.id}`).send({ status: "done" }).expect(200);
    expect((await draw(goalId)).task.id).toBe(part2.id);
    await request(app).patch(`/api/tasks/${part2.id}`).send({ status: "done" }).expect(200);
    expect((await draw(goalId)).task.id).toBe(stepC.id);

    // Child list order: done A, parts in B's slot, then C.
    const titles = (await listedTask(parent.id)).subtasks.map((s: any) => s.title);
    expect(titles).toEqual(["queue A", "split part 1", "split part 2", "queue C"]);
  });

  it("the archived original never gates the queue — no write needed (ADR-2/8.1)", async () => {
    const { goalId, parent } = await seedGoalParent("split-nogate");
    const [first, second] = await addSubtasks(
      parent.id,
      [
        { title: "gate first", effortMinutes: 45 },
        { title: "gate second", effortMinutes: 5 },
      ],
      "sequential",
    );
    backdate([first.id, second.id]);
    // Before: the oversized exposed first step gates the queue (all_too_big).
    expect((await draw(goalId)).reason).toBe("all_too_big");
    expect((await listedTask(second.id)).heldBack).toBe(1);

    const [part1] = await split(first.id, TWO_PARTS);

    // After: the parts hold the slot; the archived original itself gates
    // nothing — the first part is drawable, second (still open) stays behind.
    expect((await draw(goalId)).task.id).toBe(part1.id);
    expect((await listedTask(second.id)).heldBack).toBe(1);
  });
});

describe("guards", () => {
  it("404s an unknown id", async () => {
    await request(app).post("/api/tasks/999999/split").send({ parts: TWO_PARTS }).expect(404);
  });

  it("400s a root task — splitting in place is the subtask path, roots have Break down", async () => {
    const { parent } = await seedGoalParent("split-root");
    const res = await request(app)
      .post(`/api/tasks/${parent.id}/split`)
      .send({ parts: TWO_PARTS })
      .expect(400);
    expect(res.body.error).toMatch(/break a too-big root task down/);
  });

  it("400s a done or archived original — nothing to split", async () => {
    const { parent } = await seedGoalParent("split-closed");
    const [doneStep, archivedStep] = await addSubtasks(parent.id, [
      { title: "done step", effortMinutes: 45 },
      { title: "archived step", effortMinutes: 45 },
    ]);
    await request(app).patch(`/api/tasks/${doneStep.id}`).send({ status: "done" }).expect(200);
    await request(app)
      .patch(`/api/tasks/${archivedStep.id}`)
      .send({ status: "archived" })
      .expect(200);

    for (const id of [doneStep.id, archivedStep.id]) {
      const res = await request(app)
        .post(`/api/tasks/${id}/split`)
        .send({ parts: TWO_PARTS })
        .expect(400);
      expect(res.body.error).toMatch(/only an open subtask/);
    }
  });

  it("400s a recurring original — parts are one-shot; drop the recurrence first (ADR-23's repair)", async () => {
    const { parent } = await seedGoalParent("split-recurring");
    const [step] = await addSubtasks(parent.id, [{ title: "recurring step", effortMinutes: 45 }]);
    await request(app).patch(`/api/tasks/${step.id}`).send({ recurEveryDays: 3 }).expect(200);

    const res = await request(app)
      .post(`/api/tasks/${step.id}/split`)
      .send({ parts: TWO_PARTS })
      .expect(400);
    expect(res.body.error).toMatch(/drop the recurrence first/);

    // The prescribed repair unlocks the split.
    await request(app).patch(`/api/tasks/${step.id}`).send({ recurEveryDays: null }).expect(200);
    await split(step.id, TWO_PARTS);
  });

  it("400s fewer than 2 parts, empty titles and bad effortMinutes; parts never carry a recurrence", async () => {
    const { parent } = await seedGoalParent("split-shapes");
    const [step] = await addSubtasks(parent.id, [{ title: "shape step", effortMinutes: 45 }]);

    await split(step.id, undefined, 400);
    await split(step.id, [], 400);
    await split(step.id, [{ title: "alone", effortMinutes: 45 }], 400);
    await split(step.id, [{ title: "", effortMinutes: 20 }, { title: "b", effortMinutes: 20 }], 400);
    await split(step.id, [{ title: "a" }, { title: "b", effortMinutes: 20 }], 400);
    await split(step.id, [{ title: "a", effortMinutes: 0 }, { title: "b", effortMinutes: 20 }], 400);
    await split(step.id, [{ title: "a", effortMinutes: 1.5 }, { title: "b", effortMinutes: 20 }], 400);
    // Nothing written by any of the rejections.
    expect((await listedTask(parent.id)).subtasks.map((s: any) => s.title)).toEqual(["shape step"]);

    // A smuggled recurrence field is ignored — the INSERT has no recurrence
    // column, so parts under a sequential parent can never mint ADR-23's ban.
    const parts = await split(step.id, [
      { title: "one-shot 1", effortMinutes: 20, recurEveryDays: 2 },
      { title: "one-shot 2", effortMinutes: 25 },
    ]);
    expect(parts[0].recurEveryDays).toBeNull();
  });

  it("accepts parts above max_draw_effort — still too big, so they can be split again (repetition, not depth)", async () => {
    const { parent } = await seedGoalParent("split-again");
    const [step] = await addSubtasks(parent.id, [{ title: "huge step", effortMinutes: 120 }]);

    const [bigPart] = await split(step.id, [
      { title: "still oversized", effortMinutes: 80 },
      { title: "fine", effortMinutes: 40 },
    ]);
    expect(bigPart.effortMinutes).toBe(80);

    // The unlimited-by-repetition property: the oversized part splits again.
    const grandParts = await split(bigPart.id, [
      { title: "second round 1", effortMinutes: 40 },
      { title: "second round 2", effortMinutes: 40 },
    ]);
    expect(grandParts.map((p: any) => p.parentId)).toEqual([parent.id, parent.id]);
  });
});

describe("the archived original is out of every derived surface — with no write (ADR-2/8.1)", () => {
  it("is invisible in the child list, out of the pool and out of the rollup", async () => {
    const { goalId, parent } = await seedGoalParent("split-surfaces");
    const [original] = await addSubtasks(parent.id, [{ title: "surface step", effortMinutes: 45 }]);
    expect((await listedTask(parent.id)).remainingEffortMinutes).toBe(45);

    await split(original.id, TWO_PARTS);

    const listedParent = await listedTask(parent.id);
    // Child list: only the parts. Rollup: open children only — 25 + 20.
    expect(listedParent.subtasks.map((s: any) => s.title)).toEqual([
      "split part 1",
      "split part 2",
    ]);
    expect(listedParent.remainingEffortMinutes).toBe(45);
    await request(app)
      .patch(`/api/tasks/${listedParent.subtasks[0].id}`)
      .send({ status: "done" })
      .expect(200);
    expect((await listedTask(parent.id)).remainingEffortMinutes).toBe(20);

    // Pool: the archived original is never drawn (both draws hit the parts).
    const drawn = await draw(goalId);
    expect(drawn.task.title).toBe("split part 2");
  });

  it("does not block parent completion — the 409 gate counts open children only", async () => {
    const { parent } = await seedGoalParent("split-complete");
    const [original] = await addSubtasks(parent.id, [{ title: "gate step", effortMinutes: 45 }]);
    const parts = await split(original.id, TWO_PARTS);

    // With the parts open the parent still 409s…
    await request(app).patch(`/api/tasks/${parent.id}`).send({ status: "done" }).expect(409);
    for (const part of parts) {
      await request(app).patch(`/api/tasks/${part.id}`).send({ status: "done" }).expect(200);
    }
    // …and completes normally once they are done, archived original present.
    const res = await request(app)
      .patch(`/api/tasks/${parent.id}`)
      .send({ status: "done" })
      .expect(200);
    expect(res.body.task.status).toBe("done");
  });
});
