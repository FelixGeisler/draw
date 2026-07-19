import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import type Database from "better-sqlite3";
import { freshApp, testDb } from "../helpers.js";

// Reparenting (#100): PATCH /api/tasks/:id accepts parentId — an id adopts
// the task as a subtask of a root target, null promotes it back to root.
// Pins the full validation matrix (named 400s, #84 style), the adoption
// inheritance semantics (overwrite; single-create parity for SENT values),
// the created_at queue position under sequential parents (ADR-18), the
// parent-revives-as-leaf fallout (ADR-2), and both current-draw pointer
// cases (ADR-13/ADR-17).

let app: express.Express;
let db: Database.Database;

beforeAll(async () => {
  app = await freshApp();
  db = await testDb();
});

async function mkTask(fields: Record<string, unknown>) {
  return (
    await request(app)
      .post("/api/tasks")
      .send({ categoryId: 1, ...fields })
      .expect(201)
  ).body;
}

async function mkGoal(title: string) {
  return (await request(app).post("/api/goals").send({ title }).expect(201)).body;
}

async function patchTask(id: number, body: Record<string, unknown>, status = 200) {
  return (await request(app).patch(`/api/tasks/${id}`).send(body).expect(status)).body;
}

async function subtasksOf(
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

async function listedTask(id: number) {
  const list = (await request(app).get("/api/tasks?status=all").expect(200)).body;
  for (const root of list) {
    if (root.id === id) return root;
    const sub = (root.subtasks ?? []).find((s: { id: number }) => s.id === id);
    if (sub) return sub;
  }
  return undefined;
}

async function draw(goalId: number) {
  return (await request(app).post("/api/draw").send({ goalId }).expect(200)).body;
}

describe("validation matrix — every rule answers with a named 400", () => {
  it("rejects a non-integer parentId as a shape error", async () => {
    const t = await mkTask({ title: "shape mover" });
    for (const parentId of ["7", 1.5, 0, -1, true]) {
      const res = await patchTask(t.id, { parentId }, 400);
      expect(res.error).toContain("parentId must be a positive integer or null");
    }
  });

  it("rejects a nonexistent target with a clear 400, not an FK 500", async () => {
    const t = await mkTask({ title: "dangling mover" });
    const res = await patchTask(t.id, { parentId: 99999 }, 400);
    expect(res.error).toContain("parent task not found");
  });

  it("rejects a target that is itself a subtask (one level deep, ADR-16)", async () => {
    const root = await mkTask({ title: "matrix root" });
    const [child] = await subtasksOf(root.id, [{ title: "matrix child" }]);
    const mover = await mkTask({ title: "matrix mover" });
    const res = await patchTask(mover.id, { parentId: child.id }, 400);
    expect(res.error).toContain("one level deep");
  });

  it("rejects moving a task that has children of ANY status", async () => {
    const target = await mkTask({ title: "any-status target" });
    const parent = await mkTask({ title: "any-status parent" });
    const [child] = await subtasksOf(parent.id, [{ title: "any-status child" }]);

    const open = await patchTask(parent.id, { parentId: target.id }, 400);
    expect(open.error).toContain("cannot become a subtask itself");

    // A done child is one status write away from being an open grandchild.
    await patchTask(child.id, { status: "done" });
    const done = await patchTask(parent.id, { parentId: target.id }, 400);
    expect(done.error).toContain("cannot become a subtask itself");

    // Archived children are hidden from the list payload but still counted.
    await patchTask(child.id, { status: "archived" });
    const archived = await patchTask(parent.id, { parentId: target.id }, 400);
    expect(archived.error).toContain("cannot become a subtask itself");
  });

  it("rejects a recurring task moving into a sequential breakdown (ADR-23), judged on the effective recurrence", async () => {
    const seqParent = await mkTask({ title: "matrix seq parent" });
    await subtasksOf(seqParent.id, [{ title: "matrix seq step" }], "sequential");

    const chore = await mkTask({ title: "matrix recurring chore", recurEveryDays: 7 });
    const stored = await patchTask(chore.id, { parentId: seqParent.id }, 400);
    expect(stored.error).toContain("ADR-23");

    // Adding the recurrence in the same PATCH is the same transition…
    const plain = await mkTask({ title: "matrix plain mover" });
    const added = await patchTask(plain.id, { parentId: seqParent.id, recurEveryDays: 3 }, 400);
    expect(added.error).toContain("ADR-23");

    // …while clearing it in the same PATCH legalizes the move.
    const reformed = await mkTask({ title: "matrix reformed chore", recurEveryDays: 7 });
    const ok = await patchTask(reformed.id, { parentId: seqParent.id, recurEveryDays: null });
    expect(ok.task.parentId).toBe(seqParent.id);
    expect(ok.task.recurEveryDays).toBeNull();

    // A parallel breakdown takes the recurring chore — only sequential is banned.
    const parParent = await mkTask({ title: "matrix par parent" });
    await subtasksOf(parParent.id, [{ title: "matrix par step" }]);
    const adopted = await patchTask(chore.id, { parentId: parParent.id });
    expect(adopted.task.parentId).toBe(parParent.id);
    expect(adopted.task.recurEveryDays).toBe(7);
  });

  it("rejects a task as its own parent", async () => {
    const t = await mkTask({ title: "self mover" });
    const res = await patchTask(t.id, { parentId: t.id }, 400);
    expect(res.error).toContain("own parent");
  });

  it("404s an unknown task id", async () => {
    await request(app).patch("/api/tasks/99999").send({ parentId: null }).expect(404);
  });
});

describe("no-ops (resend tolerance)", () => {
  it("accepts null on a root and the stored parent id on a subtask", async () => {
    const root = await mkTask({ title: "noop root", effortMinutes: 10 });
    const kept = await patchTask(root.id, { parentId: null });
    expect(kept.task.parentId).toBeNull();

    const parent = await mkTask({ title: "noop parent" });
    const [child] = await subtasksOf(parent.id, [{ title: "noop child" }]);
    const same = await patchTask(child.id, { parentId: parent.id });
    expect(same.task.parentId).toBe(parent.id);
  });

  it("keeps a pre-ban recurring step under a sequential parent editable (ADR-23 tolerance)", async () => {
    const parent = await mkTask({ title: "legacy seq parent" });
    const [step] = await subtasksOf(parent.id, [{ title: "legacy step" }], "sequential");
    // Mint the combination the API refuses to create — the v7 migration can
    // leave it behind (ADR-24), and such rows must stay operable.
    db.prepare("UPDATE tasks SET recur_every_days = 5 WHERE id = ?").run(step.id);

    const res = await patchTask(step.id, { parentId: parent.id });
    expect(res.task.parentId).toBe(parent.id);
    expect(res.task.recurEveryDays).toBe(5);
  });
});

describe("adoption inheritance — overwrite semantics (#84 parity for SENT values)", () => {
  it("overwrites a divergent stored goal unconditionally, category while open, and keeps impact when a goal is set", async () => {
    const goalA = await mkGoal("adopt goal A");
    const goalB = await mkGoal("adopt goal B");
    const parent = await mkTask({
      title: "adopt parent",
      categoryId: 2,
      goalId: goalB.id,
      impact: 4,
    });
    const mover = await mkTask({
      title: "adopt mover",
      categoryId: 1,
      goalId: goalA.id,
      impact: 5,
      effortMinutes: 10,
    });

    const res = await patchTask(mover.id, { parentId: parent.id });
    expect(res.task).toMatchObject({
      parentId: parent.id,
      goalId: goalB.id, // stored divergent value is overwritten, not rejected
      categoryId: 2, // open → follows the parent
      impact: 5, // now rates the inherited goal — kept, re-ratable
    });
  });

  it("keeps the category a done task was finished under (#44) while the goal still follows", async () => {
    const goal = await mkGoal("done-adopt goal");
    const parent = await mkTask({ title: "done-adopt parent", categoryId: 2, goalId: goal.id });
    const mover = await mkTask({ title: "done-adopt mover", categoryId: 1, effortMinutes: 5 });
    await patchTask(mover.id, { status: "done" });

    const res = await patchTask(mover.id, { parentId: parent.id });
    expect(res.task).toMatchObject({ parentId: parent.id, goalId: goal.id, categoryId: 1 });
  });

  it("treats adoption into a goal-less parent as a deliberate unlink: goal wiped, impact reset to 3 (ADR-4, #76)", async () => {
    const goal = await mkGoal("wiped goal");
    const parent = await mkTask({ title: "goal-less adopt parent" });
    const mover = await mkTask({
      title: "rated mover",
      goalId: goal.id,
      impact: 5,
      effortMinutes: 10,
    });

    const res = await patchTask(mover.id, { parentId: parent.id });
    expect(res.task).toMatchObject({ parentId: parent.id, goalId: null, impact: 3 });
  });

  it("keeps a DONE mover's rating when adoption into a goal-less parent wipes the goal (#104 item 2)", async () => {
    // The impact reset is an unlink SIDE EFFECT, scoped to open movers — a done
    // row is a historical record whose rating the stats buckets attribute the
    // finished work by (#44/#76 draw the same open-only line). The goal still
    // follows the new root; the rating is grandfathered exactly like a goal
    // deletion leaves it.
    const goal = await mkGoal("done-mover goal");
    const parent = await mkTask({ title: "goal-less done-adopt parent" });
    const mover = await mkTask({
      title: "rated done mover",
      goalId: goal.id,
      impact: 5,
      effortMinutes: 10,
    });
    await patchTask(mover.id, { status: "done" });

    const res = await patchTask(mover.id, { parentId: parent.id });
    expect(res.task).toMatchObject({ parentId: parent.id, goalId: null, impact: 5 });

    // Grandfathered, not re-rateable to a new non-neutral value (ADR-4): only
    // a no-op resend or the neutral 3 is accepted afterwards.
    const bumped = await patchTask(mover.id, { impact: 4 }, 400);
    expect(bumped.error).toContain("goal");
    const neutral = await patchTask(mover.id, { impact: 3 });
    expect(neutral.task.impact).toBe(3);
  });

  it("still resets a done mover's impact when the unlink is a DELIBERATE sent goalId: null, not a move (#104 item 2)", async () => {
    // Scoping is about the move, not the status: unlinking a done task's goal
    // by hand is an explicit rating decision and resets to the neutral 3, the
    // same as the open path — no reparent is involved here.
    const goal = await mkGoal("deliberate done unlink goal");
    const mover = await mkTask({
      title: "deliberate done unlink mover",
      goalId: goal.id,
      impact: 5,
      effortMinutes: 10,
    });
    await patchTask(mover.id, { status: "done" });

    const res = await patchTask(mover.id, { goalId: null });
    expect(res.task).toMatchObject({ goalId: null, impact: 3 });
  });

  it("rejects keeping a rating while adoption wipes the goal — the unlink contradiction", async () => {
    const goal = await mkGoal("contradiction goal");
    const parent = await mkTask({ title: "contradiction parent" });
    const mover = await mkTask({ title: "contradiction mover", goalId: goal.id, impact: 5 });

    const res = await patchTask(mover.id, { parentId: parent.id, impact: 5 }, 400);
    expect(res.error).toContain("ADR-4");
    expect(res.error).toContain("goal-less");

    // The rejected PATCH wrote nothing.
    const untouched = await listedTask(mover.id);
    expect(untouched).toMatchObject({ parentId: null, goalId: goal.id, impact: 5 });
  });

  it("keeps a grandfathered rating when adoption wipes nothing (goal-less into goal-less)", async () => {
    const goal = await mkGoal("doomed adopt goal");
    const mover = await mkTask({
      title: "grandfathered mover",
      goalId: goal.id,
      impact: 5,
      effortMinutes: 10,
    });
    // Goal deletion grandfathers the rating (goal_id NULL, impact 5 kept).
    await request(app).delete(`/api/goals/${goal.id}`).expect(200);
    const parent = await mkTask({ title: "grandfather parent" });

    const res = await patchTask(mover.id, { parentId: parent.id });
    expect(res.task).toMatchObject({ parentId: parent.id, goalId: null, impact: 5 });
  });

  it("rejects SENT divergent links but accepts resends of the parent's own (#84 parity)", async () => {
    const goalA = await mkGoal("divergence goal A");
    const goalB = await mkGoal("divergence goal B");
    const parent = await mkTask({ title: "divergence parent", categoryId: 2, goalId: goalB.id });
    const mover = await mkTask({ title: "divergence mover", categoryId: 1 });

    const goalDiv = await patchTask(mover.id, { parentId: parent.id, goalId: goalA.id }, 400);
    expect(goalDiv.error).toContain("subtasks follow their parent's goal");
    const catDiv = await patchTask(mover.id, { parentId: parent.id, categoryId: 1 }, 400);
    expect(catDiv.error).toContain("inherit their parent's category");

    const ok = await patchTask(mover.id, {
      parentId: parent.id,
      goalId: goalB.id,
      categoryId: 2,
    });
    expect(ok.task).toMatchObject({ parentId: parent.id, goalId: goalB.id, categoryId: 2 });
  });

  it("treats goalId: null as unspecified on the adoption path — inheritance is unconditional", async () => {
    const goal = await mkGoal("null-unspecified goal");
    const parent = await mkTask({ title: "null-unspecified parent", goalId: goal.id });
    const mover = await mkTask({ title: "null-unspecified mover" });

    const res = await patchTask(mover.id, { parentId: parent.id, goalId: null });
    expect(res.task.goalId).toBe(goal.id);
  });
});

describe("promote to root", () => {
  it("keeps goal, category and impact — no unlink semantics", async () => {
    const goal = await mkGoal("promote goal");
    const parent = await mkTask({
      title: "promote parent",
      categoryId: 2,
      goalId: goal.id,
      impact: 4,
    });
    const [sub] = await subtasksOf(parent.id, [
      { title: "promoted step", effortMinutes: 10, impact: 5 },
    ]);

    const res = await patchTask(sub.id, { parentId: null });
    expect(res.task).toMatchObject({
      parentId: null,
      goalId: goal.id,
      categoryId: 2,
      impact: 5,
    });

    // It lists as a root of its own now.
    const roots = (await request(app).get("/api/tasks").expect(200)).body;
    expect(roots.some((t: { id: number }) => t.id === sub.id)).toBe(true);
  });
});

describe("sequential queue position (ADR-18/ADR-43): adoption keeps its stored sort_order", () => {
  it("an older adopted task enters the queue AHEAD of the existing steps", async () => {
    const goal = await mkGoal("queue goal");
    const old = await mkTask({ title: "queue old-timer", goalId: goal.id, effortMinutes: 10 });
    // An adopted task keeps its own sort_order — this PATCH does not touch it.
    // `old` is created before the parent's steps, so its stamped sort_order
    // (= its id) is the lowest of the three; that is what puts it AHEAD once
    // adopted (sibling order is (sort_order, id) since #157). The created_at
    // backdate no longer affects order — kept only to age the card for weight.
    db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(
      "2020-01-01T00:00:00.000Z",
      old.id,
    );
    const parent = await mkTask({ title: "queue parent", goalId: goal.id });
    const [stepA, stepB] = await subtasksOf(
      parent.id,
      [
        { title: "queue step A", effortMinutes: 10 },
        { title: "queue step B", effortMinutes: 10 },
      ],
      "sequential",
    );

    await patchTask(old.id, { parentId: parent.id });

    // The child listing reads top-down in (sort_order, id)…
    const listedParent = await listedTask(parent.id);
    expect(listedParent.subtasks.map((s: { title: string }) => s.title)).toEqual([
      "queue old-timer",
      "queue step A",
      "queue step B",
    ]);
    // …and the hold-back predicate exposes only the adopted front card.
    expect((await listedTask(old.id)).heldBack).toBe(0);
    expect((await listedTask(stepA.id)).heldBack).toBe(1);
    expect((await listedTask(stepB.id)).heldBack).toBe(1);

    // The goal-scoped draw picks the queue-jumper.
    const drawn = await draw(goal.id);
    expect(drawn.task.id).toBe(old.id);
    expect(drawn.poolSize).toBe(1);
  });
});

describe("parent revives as a leaf (ADR-2 — derived, no write needed)", () => {
  it("falls back to its stored effort and becomes draw-eligible again", async () => {
    const goal = await mkGoal("revive goal");
    const parent = await mkTask({ title: "revive parent", goalId: goal.id, effortMinutes: 20 });
    const [only] = await subtasksOf(parent.id, [{ title: "revive only step", effortMinutes: 10 }]);
    // While the child is open the parent is a container: the pool holds the child.
    expect((await draw(goal.id)).task.id).toBe(only.id);

    // Reparent the last open subtask away, under a foster root elsewhere.
    const foster = await mkTask({ title: "revive foster parent" });
    await patchTask(only.id, { parentId: foster.id });

    const listed = await listedTask(parent.id);
    expect(listed.hasOpenChildren).toBe(0);
    expect(listed.remainingEffortMinutes).toBe(20); // stored estimate again
    expect((await draw(goal.id)).task.id).toBe(parent.id); // drawable, no write
  });

  it("revives into needs-estimate when the stored effort is NULL", async () => {
    const goal = await mkGoal("unsized revive goal");
    const parent = await mkTask({ title: "unsized revive parent", goalId: goal.id });
    const [only] = await subtasksOf(parent.id, [{ title: "unsized revive step", effortMinutes: 10 }]);
    const foster = await mkTask({ title: "unsized foster" });
    await patchTask(only.id, { parentId: foster.id });

    expect((await listedTask(parent.id)).remainingEffortMinutes).toBeNull(); // client: needs-estimate
    const empty = await draw(goal.id);
    expect(empty.task).toBeNull();
    expect(empty.reason).toBe("all_too_big"); // open but unestimated → the estimate/breakdown hint
  });

  it("revives into Too big when the stored effort exceeds max_draw_effort", async () => {
    const goal = await mkGoal("oversized revive goal");
    const parent = await mkTask({ title: "oversized revive parent", goalId: goal.id, effortMinutes: 90 });
    const [only] = await subtasksOf(parent.id, [{ title: "oversized revive step", effortMinutes: 10 }]);
    const foster = await mkTask({ title: "oversized foster" });
    await patchTask(only.id, { parentId: foster.id });

    expect((await listedTask(parent.id)).remainingEffortMinutes).toBe(90);
    const empty = await draw(goal.id);
    expect(empty.task).toBeNull();
    expect(empty.reason).toBe("all_too_big");
  });
});

describe("current draw pointer (ADR-13/ADR-17)", () => {
  async function currentDraw() {
    return (await request(app).get("/api/draw/current").expect(200)).body;
  }
  function persistedDrawId(): string | undefined {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'current_draw_task_id'")
      .get() as { value: string } | undefined;
    return row?.value;
  }

  it("eagerly clears the pointer when the drawn card moves into a held-back position", async () => {
    const goal = await mkGoal("eager goal");
    const drawn = await mkTask({ title: "eager drawn", goalId: goal.id, effortMinutes: 10 });
    const seqParent = await mkTask({ title: "eager seq parent" });
    const [front] = await subtasksOf(
      seqParent.id,
      [{ title: "eager front step", effortMinutes: 5 }],
      "sequential",
    );
    // The front step must sort AHEAD of the drawn card so the adopted card
    // queues BEHIND it (held-back). sort_order is a global creation sequence
    // (#157, ADR-43), not the id, and the front step was created AFTER the
    // drawn card, so it naturally sorts later — read the drawn card's actual
    // sort_order and pin front just below it to reproduce the held-back landing.
    const drawnOrder = (
      db.prepare("SELECT sort_order AS so FROM tasks WHERE id = ?").get(drawn.id) as { so: number }
    ).so;
    db.prepare("UPDATE tasks SET sort_order = ? WHERE id = ?").run(drawnOrder - 0.5, front.id);

    expect((await draw(goal.id)).task.id).toBe(drawn.id);
    expect(persistedDrawId()).toBe(String(drawn.id));

    await patchTask(drawn.id, { parentId: seqParent.id });

    // EAGER: the pointer is gone before any GET /api/draw/current runs — a
    // completed front sibling later must not resurrect the card.
    expect(persistedDrawId()).toBeUndefined();
    await patchTask(front.id, { status: "done" });
    expect(await currentDraw()).toBeNull();
  });

  it("keeps the pointer when the drawn card is adopted somewhere it stays drawable", async () => {
    const goal = await mkGoal("kept goal");
    const drawn = await mkTask({ title: "kept drawn", goalId: goal.id, effortMinutes: 10 });
    const parParent = await mkTask({ title: "kept par parent" });

    expect((await draw(goal.id)).task.id).toBe(drawn.id);
    await patchTask(drawn.id, { parentId: parParent.id });

    // Still a leaf of a parallel breakdown — still in the deck, still restored.
    expect(persistedDrawId()).toBe(String(drawn.id));
    expect((await currentDraw()).task.id).toBe(drawn.id);
  });

  it("lazily clears the pointer when adoption turns the drawn card into a container", async () => {
    const goal = await mkGoal("container goal");
    const drawn = await mkTask({ title: "container drawn", goalId: goal.id, effortMinutes: 10 });
    expect((await draw(goal.id)).task.id).toBe(drawn.id);

    const mover = await mkTask({ title: "container mover", effortMinutes: 5 });
    await patchTask(mover.id, { parentId: drawn.id });

    // The PATCH ran on the CHILD's id, so the eager clear cannot see the
    // drawn card — the pointer survives the write…
    expect(persistedDrawId()).toBe(String(drawn.id));
    // …and the next GET's lazy restore validation (isRestorable rejects
    // hasOpenChildren) clears it.
    expect(await currentDraw()).toBeNull();
    expect(persistedDrawId()).toBeUndefined();
  });
});

// #104 item 1: an archived task cannot take subtasks on ANY path — adoption via
// PATCH, single create, or the batch. Leaving it legal left an open child
// drawable from the pool (which filters the CHILD's status, ADR-2) yet hidden
// on the Tasks page with its archived root. The prescribed repair is to
// un-archive the root first, matching #122's archived→done shape: the system
// never lifts the archived state implicitly.
describe("archived parents take no children (#104 item 1)", () => {
  async function archivedRoot(title: string) {
    const root = await mkTask({ title, effortMinutes: 10 });
    await patchTask(root.id, { status: "archived" });
    return root;
  }

  it("rejects adopting an OPEN task under an archived root, writing nothing", async () => {
    const root = await archivedRoot("archived adopt root");
    const mover = await mkTask({ title: "open archived-adopt mover", effortMinutes: 5 });

    const res = await patchTask(mover.id, { parentId: root.id }, 400);
    expect(res.error).toContain("archived");
    expect(res.error).toContain("un-archive");

    // The mover is untouched — still a root, still parentless.
    expect((await listedTask(mover.id)).parentId).toBeNull();
    // And the root stays archived (no implicit revival).
    const root400 = db.prepare("SELECT status FROM tasks WHERE id = ?").get(root.id) as {
      status: string;
    };
    expect(root400.status).toBe("archived");
  });

  it("rejects adopting a DONE task under an archived root too — the guard is status-blind on the mover", async () => {
    const root = await archivedRoot("archived done-adopt root");
    const mover = await mkTask({ title: "done archived-adopt mover", effortMinutes: 5 });
    await patchTask(mover.id, { status: "done" });

    const res = await patchTask(mover.id, { parentId: root.id }, 400);
    expect(res.error).toContain("archived");
  });

  it("rejects a single create under an archived parent", async () => {
    const root = await archivedRoot("archived single-create root");
    const res = await request(app)
      .post("/api/tasks")
      .send({ title: "archived single child", categoryId: 1, parentId: root.id })
      .expect(400);
    expect(res.body.error).toContain("archived");
  });

  it("rejects a batch breakdown under an archived parent", async () => {
    const root = await archivedRoot("archived batch root");
    const res = await request(app)
      .post(`/api/tasks/${root.id}/subtasks`)
      .send({ subtasks: [{ title: "archived batch child", effortMinutes: 5 }] })
      .expect(400);
    expect(res.body.error).toContain("archived");
  });

  it("the prescribed repair works: un-archive the root, then adopt", async () => {
    const root = await archivedRoot("archived-then-revived root");
    const mover = await mkTask({ title: "repair mover", effortMinutes: 5 });

    await patchTask(root.id, { status: "open" });
    const ok = await patchTask(mover.id, { parentId: root.id });
    expect(ok.task.parentId).toBe(root.id);
  });

  it("a DONE root still adopts and reopens — only archived is barred (#111 vs #104)", async () => {
    // Guards the boundary: the fix must not have broadened to done roots, whose
    // adoption-reopen (#111) is deliberately kept.
    const root = await mkTask({ title: "done adopt-reopen root", effortMinutes: 10 });
    await patchTask(root.id, { status: "done" });
    const mover = await mkTask({ title: "reopen-trigger mover", effortMinutes: 5 });

    const ok = await patchTask(mover.id, { parentId: root.id });
    expect(ok.task.parentId).toBe(root.id);
    const rootAfter = db.prepare("SELECT status FROM tasks WHERE id = ?").get(root.id) as {
      status: string;
    };
    expect(rootAfter.status).toBe("open"); // reopened, its completion undone
  });
});

// #104 item 4: a body that reopens a DONE task (status: 'open') AND carries a
// parentId reopens it but drops the move — the reopen branch returns before the
// generic field write. Deliberate and now documented in the MCP update_task
// description; this pins the behavior so the docs stay true.
describe("reopen + reparent in one body drops the move (#104 item 4)", () => {
  it("reopens the task but leaves it under its original parent", async () => {
    const oldParent = await mkTask({ title: "reopen-move old parent" });
    const [child] = await subtasksOf(oldParent.id, [
      { title: "reopen-move child", effortMinutes: 10 },
    ]);
    await patchTask(child.id, { status: "done" });
    const newParent = await mkTask({ title: "reopen-move new parent" });

    const res = await patchTask(child.id, { status: "open", parentId: newParent.id });
    // Reopened…
    expect(res.task.status).toBe("open");
    // …but NOT moved: still under the original parent.
    expect(res.task.parentId).toBe(oldParent.id);
  });
});
