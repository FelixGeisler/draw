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

  it("a blocked first subtask still holds its siblings back — snooze covers block too", async () => {
    const { goalId, parent } = await seedGoalParent("blocked-gate");
    const [first, second] = await addSubtasks(
      parent.id,
      [
        { title: "blocked gate first", effortMinutes: 5 },
        { title: "blocked gate second", effortMinutes: 5 },
      ],
      "sequential",
    );

    await request(app).patch(`/api/tasks/${first.id}`).send({ blocked: true }).expect(200);

    // blocked keeps status = 'open', so heldBackSql still gates the sibling…
    expect((await listedTask(second.id)).heldBack).toBe(1);
    // …and the pool is honestly empty, same as the deferred variant above:
    // ADR-18's "a snoozed first subtask still gates its siblings" covers both
    // halves of snooze — deferred OR blocked (ADR-17).
    const res = await draw(goalId);
    expect(res.task).toBeNull();
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

// Issue #66 (ADR-23): a recurring step never closes on completion (ADR-6
// advances its due date), so under a sequential parent it would gate every
// later sibling forever. The combination is banned on every path that could
// create it; pre-ban rows stay operable (no-op resends pass) and the trap
// they carry is pinned below as the ban's motivation.
describe("recurring subtasks are banned under sequential parents (#66, ADR-23)", () => {
  const BAN = /sequential breakdown \(ADR-23\)/;

  it("rejects creating a recurring subtask under a sequential parent (POST /api/tasks)", async () => {
    const { parent } = await seedGoalParent("ban-create");
    await addSubtasks(parent.id, [{ title: "ban-create step", effortMinutes: 5 }], "sequential");

    const res = await request(app)
      .post("/api/tasks")
      .send({ title: "daily interloper", categoryId: 1, parentId: parent.id, recurEveryDays: 1 })
      .expect(400);
    expect(res.body.error).toMatch(BAN);

    // Without the recurrence the same create is fine.
    await request(app)
      .post("/api/tasks")
      .send({ title: "one-shot step", categoryId: 1, parentId: parent.id })
      .expect(201);
  });

  it("allows recurring subtasks under a parallel parent — a routine container is legitimate", async () => {
    const { parent } = await seedGoalParent("parallel-recur");
    await addSubtasks(parent.id, [{ title: "parallel-recur step", effortMinutes: 5 }]);

    await request(app)
      .post("/api/tasks")
      .send({ title: "daily chore", categoryId: 1, parentId: parent.id, recurEveryDays: 2 })
      .expect(201);
  });

  it("rejects adding a recurrence to an existing step of a sequential parent (PATCH)", async () => {
    const { parent } = await seedGoalParent("ban-patch");
    const [step] = await addSubtasks(
      parent.id,
      [{ title: "ban-patch step", effortMinutes: 5 }],
      "sequential",
    );

    const res = await request(app)
      .patch(`/api/tasks/${step.id}`)
      .send({ recurEveryDays: 7 })
      .expect(400);
    expect(res.body.error).toMatch(BAN);

    // Clearing (null) and unrelated edits stay allowed.
    await request(app).patch(`/api/tasks/${step.id}`).send({ recurEveryDays: null }).expect(200);
    await request(app).patch(`/api/tasks/${step.id}`).send({ title: "renamed step" }).expect(200);
  });

  it("rejects flipping a parent to sequential while a subtask is recurring; clearing the recurrence unlocks it", async () => {
    const { parent } = await seedGoalParent("ban-flip");
    const [step] = await addSubtasks(parent.id, [{ title: "ban-flip step", effortMinutes: 5 }]);
    await request(app).patch(`/api/tasks/${step.id}`).send({ recurEveryDays: 3 }).expect(200);

    const res = await request(app)
      .patch(`/api/tasks/${parent.id}`)
      .send({ subtaskOrderMode: "sequential" })
      .expect(400);
    expect(res.body.error).toMatch(BAN);
    expect((await listedTask(parent.id)).subtaskOrderMode).toBe("parallel");

    await request(app).patch(`/api/tasks/${step.id}`).send({ recurEveryDays: null }).expect(200);
    await request(app)
      .patch(`/api/tasks/${parent.id}`)
      .send({ subtaskOrderMode: "sequential" })
      .expect(200);
  });

  it("the flip guard sees done subtasks too — a reopen would otherwise revive the trap", async () => {
    const { parent } = await seedGoalParent("ban-flip-done");
    const [a] = await addSubtasks(parent.id, [
      { title: "ban-flip-done a", effortMinutes: 5 },
      { title: "ban-flip-done b", effortMinutes: 5 },
    ]);
    // A done non-recurring step may gain a recurrence under a parallel parent…
    await request(app).patch(`/api/tasks/${a.id}`).send({ status: "done" }).expect(200);
    await request(app).patch(`/api/tasks/${a.id}`).send({ recurEveryDays: 5 }).expect(200);

    // …but then the parent may not go sequential: reopening `a` is a plain
    // status write with no recurrence check of its own.
    await request(app)
      .patch(`/api/tasks/${parent.id}`)
      .send({ subtaskOrderMode: "sequential" })
      .expect(400);
  });

  it("the breakdown batch refuses the sequential transition next to a recurring sibling — atomically", async () => {
    const { parent } = await seedGoalParent("ban-batch");
    const [step] = await addSubtasks(parent.id, [{ title: "ban-batch step", effortMinutes: 5 }]);
    await request(app).patch(`/api/tasks/${step.id}`).send({ recurEveryDays: 2 }).expect(200);

    const res = await request(app)
      .post(`/api/tasks/${parent.id}/subtasks`)
      .send({ subtasks: [{ title: "never created" }], orderMode: "sequential" })
      .expect(400);
    expect(res.body.error).toMatch(BAN);
    // Nothing written: no new subtask, mode untouched.
    const listed = await listedTask(parent.id);
    expect(listed.subtasks.map((s: { title: string }) => s.title)).toEqual(["ban-batch step"]);
    expect(listed.subtaskOrderMode).toBe("parallel");

    // The same batch without the mode switch is fine.
    await addSubtasks(parent.id, [{ title: "created fine" }]);
  });

  it("the batch INSERT cannot smuggle a recurrence — recurEveryDays on batch rows is ignored", async () => {
    const { parent } = await seedGoalParent("no-smuggle");
    const [created] = await addSubtasks(
      parent.id,
      [{ title: "no-smuggle step", effortMinutes: 5, recurEveryDays: 4 }],
      "sequential",
    );
    expect(created.recurEveryDays).toBeNull();
  });

  it("a pre-ban database stays operable, and its recurring first step pins the trap the ban prevents", async () => {
    const { goalId, parent } = await seedGoalParent("legacy-combo");
    const [first, second] = await addSubtasks(
      parent.id,
      [
        { title: "legacy recurring first", effortMinutes: 5 },
        { title: "legacy second", effortMinutes: 5 },
      ],
      "sequential",
    );
    // The ban makes this state unreachable via the API — seed it directly,
    // as a database written before the ban would contain it.
    db.prepare("UPDATE tasks SET recur_every_days = 2 WHERE id = ?").run(first.id);

    // No-op resend of the stored recurrence (the edit form does this) passes…
    await request(app)
      .patch(`/api/tasks/${first.id}`)
      .send({ title: "legacy renamed", recurEveryDays: 2 })
      .expect(200);
    // …and so does adding steps while KEEPING the already-sequential mode.
    await addSubtasks(parent.id, [{ title: "legacy third", effortMinutes: 5 }], "sequential");

    // The trap itself (#66): completing the recurring first step does not
    // close it (ADR-6), so the sibling stays held back — forever, absent a
    // user repair (drop the recurrence, or flip the parent to parallel).
    expect((await draw(goalId)).task.id).toBe(first.id);
    const completion = await request(app)
      .patch(`/api/tasks/${first.id}`)
      .send({ status: "done" })
      .expect(200);
    expect(completion.body.recurring).toBe(true);
    expect((await listedTask(first.id)).status).toBe("open");
    expect((await listedTask(second.id)).heldBack).toBe(1);
    expect((await draw(goalId)).task.id).toBe(first.id);
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
