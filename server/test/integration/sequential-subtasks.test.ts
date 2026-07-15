import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import type Database from "better-sqlite3";
import { freshApp, testDb } from "../helpers.js";

// Issue #23 (ADR-18): a 'sequential' parent exposes only its first open
// subtask in creation order (created_at, id) to the draw pool; later open
// siblings are held back — a derived predicate like snooze/block, never a
// stored flag. Each test draws from its own goal-scoped pool, like
// snooze-block.test.ts, so the roulette pick is deterministic.

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
  status = 201,
) {
  return (
    await request(app)
      .post(`/api/tasks/${parentId}/subtasks`)
      .send(orderMode === undefined ? { subtasks } : { subtasks, orderMode })
      .expect(status)
  ).body;
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

describe("orderMode persistence on the breakdown batch", () => {
  it("persists 'do in order' on the parent in the same POST and serializes heldBack", async () => {
    const { parent } = await seedGoalParent("persist-mode");
    const subs = await addSubtasks(
      parent.id,
      [
        { title: "persist step 1", effortMinutes: 10 },
        { title: "persist step 2", effortMinutes: 10 },
      ],
      "sequential",
    );

    const listedParent = await listedTask(parent.id);
    expect(listedParent.subtaskOrderMode).toBe("sequential");
    // First open subtask is exposed; the later sibling is held back.
    expect((await listedTask(subs[0].id)).heldBack).toBe(0);
    expect((await listedTask(subs[1].id)).heldBack).toBe(1);
  });

  it("leaves the parent's mode untouched when the batch has no orderMode", async () => {
    const { parent } = await seedGoalParent("untouched-mode");
    await request(app)
      .patch(`/api/tasks/${parent.id}`)
      .send({ subtaskOrderMode: "sequential" })
      .expect(200);

    await addSubtasks(parent.id, [{ title: "untouched step" }]);
    expect((await listedTask(parent.id)).subtaskOrderMode).toBe("sequential");
  });

  it("rejects an invalid orderMode with 400 before writing anything", async () => {
    const { parent } = await seedGoalParent("invalid-mode");
    await addSubtasks(parent.id, [{ title: "never created" }], "ordered", 400);
    expect((await listedTask(parent.id)).subtasks ?? []).toEqual([]);
    expect((await listedTask(parent.id)).subtaskOrderMode).toBe("parallel");
  });

  it("rejects an invalid subtaskOrderMode PATCH with 400", async () => {
    const { parent } = await seedGoalParent("invalid-patch");
    await request(app)
      .patch(`/api/tasks/${parent.id}`)
      .send({ subtaskOrderMode: "both" })
      .expect(400);
    await request(app)
      .patch(`/api/tasks/${parent.id}`)
      .send({ subtaskOrderMode: true })
      .expect(400);
  });
});

describe("draw pool: sequential parents expose only the first open subtask", () => {
  it("only the oldest open subtask is drawn; completing it frees the next", async () => {
    const { goalId, parent } = await seedGoalParent("strict-order");
    const [a, b, c] = await addSubtasks(
      parent.id,
      [
        { title: "order A", effortMinutes: 5 },
        { title: "order B", effortMinutes: 5 },
        { title: "order C", effortMinutes: 5 },
      ],
      "sequential",
    );
    // Deterministic creation order even if the batch shares one timestamp.
    const base = Date.now() - 3_600_000;
    for (const [i, sub] of [a, b, c].entries()) {
      db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(
        new Date(base + i * 60_000).toISOString(),
        sub.id,
      );
    }

    for (let i = 0; i < 10; i++) {
      expect((await draw(goalId)).task.id).toBe(a.id);
    }

    await request(app).patch(`/api/tasks/${a.id}`).send({ status: "done" }).expect(200);
    for (let i = 0; i < 10; i++) {
      expect((await draw(goalId)).task.id).toBe(b.id);
    }
    // The freed sibling also stops reporting heldBack — with no write to it.
    expect((await listedTask(b.id)).heldBack).toBe(0);
    expect((await listedTask(c.id)).heldBack).toBe(1);
  });

  it("breaks created_at ties by id, so batch-inserted siblings stay deterministic", async () => {
    const { goalId, parent } = await seedGoalParent("tie-break");
    const subs = await addSubtasks(
      parent.id,
      [
        { title: "tie first", effortMinutes: 5 },
        { title: "tie second", effortMinutes: 5 },
      ],
      "sequential",
    );
    // Force the tie explicitly — identical created_at on both siblings.
    const sameInstant = new Date().toISOString();
    for (const sub of subs) {
      db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(sameInstant, sub.id);
    }

    for (let i = 0; i < 10; i++) {
      expect((await draw(goalId)).task.id).toBe(subs[0].id);
    }
  });

  it("parallel parents keep the current behavior — all open subtasks are in the pool", async () => {
    const { goalId, parent } = await seedGoalParent("parallel-regression");
    const subs = await addSubtasks(parent.id, [
      { title: "parallel A", effortMinutes: 10 },
      { title: "parallel B", effortMinutes: 10 },
    ]);

    const seen = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const res = await draw(goalId);
      expect(res.poolSize).toBe(2);
      seen.add(res.task.id);
    }
    // Equal weights: over 40 draws both siblings appear (P(miss) ≈ 2^-39).
    expect(seen).toEqual(new Set(subs.map((s: { id: number }) => s.id)));
  });

  it("toggling the mode moves siblings in and out of the pool with no other write", async () => {
    const { goalId, parent } = await seedGoalParent("toggle-live");
    await addSubtasks(
      parent.id,
      [
        { title: "toggle A", effortMinutes: 5 },
        { title: "toggle B", effortMinutes: 5 },
      ],
      "sequential",
    );
    expect((await draw(goalId)).poolSize).toBe(1);

    await request(app)
      .patch(`/api/tasks/${parent.id}`)
      .send({ subtaskOrderMode: "parallel" })
      .expect(200);
    expect((await draw(goalId)).poolSize).toBe(2);

    await request(app)
      .patch(`/api/tasks/${parent.id}`)
      .send({ subtaskOrderMode: "sequential" })
      .expect(200);
    expect((await draw(goalId)).poolSize).toBe(1);
  });

  it("a snoozed first subtask still holds its siblings back — order means order", async () => {
    const { goalId, parent } = await seedGoalParent("snoozed-gate");
    const [first] = await addSubtasks(
      parent.id,
      [
        { title: "gate first", effortMinutes: 5 },
        { title: "gate second", effortMinutes: 5 },
      ],
      "sequential",
    );

    await request(app)
      .patch(`/api/tasks/${first.id}`)
      .send({ deferredUntil: new Date(Date.now() + 3_600_000).toISOString() })
      .expect(200);

    const res = await draw(goalId);
    expect(res.task).toBeNull();
    // Snoozed + held-back only: the deck is honestly empty, not "too big" —
    // neither state is fixed by breaking something down.
    expect(res.reason).toBe("no_ready_tasks");
  });

  it("keeps all_too_big when the exposed first subtask is oversized", async () => {
    const { goalId, parent } = await seedGoalParent("oversized-gate");
    await addSubtasks(
      parent.id,
      [
        { title: "oversized first", effortMinutes: 240 },
        { title: "small second", effortMinutes: 5 },
      ],
      "sequential",
    );

    const res = await draw(goalId);
    expect(res.task).toBeNull();
    // The blocking step IS too big — breaking it down is the honest hint.
    expect(res.reason).toBe("all_too_big");
  });
});

describe("interaction with the persisted current draw (ADR-13)", () => {
  it("a drawn subtask that falls behind a sequential sibling is not restored", async () => {
    const { goalId, parent } = await seedGoalParent("restore-heldback");
    const subs = await addSubtasks(parent.id, [
      { title: "restore A", effortMinutes: 5 },
      { title: "restore B", effortMinutes: 5 },
    ]);
    const b = subs[1];

    // Parallel: draw until B is the current draw (pool of two, so force it by
    // pinning A out via draw retries would be flaky — draw B's id directly by
    // snoozing A, drawing B, then waking A again).
    const a = subs[0];
    await request(app)
      .patch(`/api/tasks/${a.id}`)
      .send({ deferredUntil: new Date(Date.now() + 3_600_000).toISOString() })
      .expect(200);
    expect((await draw(goalId)).task.id).toBe(b.id);
    await request(app)
      .patch(`/api/tasks/${a.id}`)
      .send({ deferredUntil: new Date().toISOString() })
      .expect(200);

    // B is the persisted draw and A is awake again. Flip the parent to
    // sequential: B now sits behind A, so the restore must come up empty.
    await request(app)
      .patch(`/api/tasks/${parent.id}`)
      .send({ subtaskOrderMode: "sequential" })
      .expect(200);
    expect((await request(app).get("/api/draw/current").expect(200)).body).toBeNull();
  });
});
