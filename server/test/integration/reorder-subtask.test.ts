import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import type Database from "better-sqlite3";
import { freshApp, testDb } from "../helpers.js";

// Issue #157 (ADR-43): POST /api/tasks/:id/reorder { beforeId } moves a subtask
// among its siblings — beforeId names the sibling it should sit before, null
// moves it to the end. Placement is a midpoint sort_order write, renormalizing
// to integer gaps only on REAL underflow. The guards: same-parent (cross-parent
// is a reparent), 404 unknown, 400 root, 400 before-self. For a sequential
// parent the reorder changes which step the draw pool exposes, and a reorder
// that strands the persisted current draw clears the pointer eagerly (ADR-13),
// the same wear-off guard the reparent path applies.

let app: express.Express;
let db: Database.Database;

beforeAll(async () => {
  app = await freshApp();
  db = await testDb();
});

async function seedGoalParent(title: string, parentOverrides: Record<string, unknown> = {}) {
  const goal = (await request(app).post("/api/goals").send({ title }).expect(201)).body;
  const parent = (
    await request(app)
      .post("/api/tasks")
      .send({ title: `${title} parent`, categoryId: 1, goalId: goal.id, ...parentOverrides })
      .expect(201)
  ).body;
  return { goalId: goal.id, parent };
}

async function addSubtasks(parentId: number, subtasks: Record<string, unknown>[], orderMode?: string) {
  return (
    await request(app)
      .post(`/api/tasks/${parentId}/subtasks`)
      .send(orderMode === undefined ? { subtasks } : { subtasks, orderMode })
      .expect(201)
  ).body;
}

async function childOrder(parentId: number): Promise<string[]> {
  const list = (await request(app).get("/api/tasks").expect(200)).body;
  const parent = list.find((t: { id: number }) => t.id === parentId);
  return parent.subtasks.map((s: { title: string }) => s.title);
}

async function reorder(id: number, beforeId: number | null, status = 200) {
  return request(app).post(`/api/tasks/${id}/reorder`).send({ beforeId }).expect(status);
}

async function draw(goalId: number) {
  return (await request(app).post("/api/draw").send({ goalId }).expect(200)).body;
}

function sortOrderOf(id: number): number {
  return (db.prepare("SELECT sort_order AS s FROM tasks WHERE id = ?").get(id) as { s: number }).s;
}

describe("POST /api/tasks/:id/reorder — placement", () => {
  it("midpoint-places a middle subtask at the front and reads the new order", async () => {
    const { parent } = await seedGoalParent("mid-to-front");
    const [a, b, c] = await addSubtasks(parent.id, [
      { title: "A", effortMinutes: 5 },
      { title: "B", effortMinutes: 5 },
      { title: "C", effortMinutes: 5 },
    ]);
    expect(await childOrder(parent.id)).toEqual(["A", "B", "C"]);

    // Move C before A → C, A, B. C's sort_order lands below A's (front bisect).
    await reorder(c.id, a.id);
    expect(await childOrder(parent.id)).toEqual(["C", "A", "B"]);
    expect(sortOrderOf(c.id)).toBeLessThan(sortOrderOf(a.id));
  });

  it("moves a subtask to the end when beforeId is null", async () => {
    const { parent } = await seedGoalParent("to-end");
    const [a, b, c] = await addSubtasks(parent.id, [
      { title: "A", effortMinutes: 5 },
      { title: "B", effortMinutes: 5 },
      { title: "C", effortMinutes: 5 },
    ]);

    await reorder(a.id, null);
    expect(await childOrder(parent.id)).toEqual(["B", "C", "A"]);
    expect(sortOrderOf(a.id)).toBeGreaterThan(sortOrderOf(c.id));
  });

  it("places between two neighbors as an exact midpoint, touching no other row", async () => {
    const { parent } = await seedGoalParent("between");
    const [a, b, c] = await addSubtasks(parent.id, [
      { title: "A", effortMinutes: 5 },
      { title: "B", effortMinutes: 5 },
      { title: "C", effortMinutes: 5 },
    ]);
    const beforeB = sortOrderOf(b.id);
    const beforeC = sortOrderOf(c.id);

    // Move A between B and C (before C).
    await reorder(a.id, c.id);
    expect(await childOrder(parent.id)).toEqual(["B", "A", "C"]);
    // The untouched neighbors keep their sort_order; A sits strictly between.
    expect(sortOrderOf(b.id)).toBe(beforeB);
    expect(sortOrderOf(c.id)).toBe(beforeC);
    expect(sortOrderOf(a.id)).toBeGreaterThan(beforeB);
    expect(sortOrderOf(a.id)).toBeLessThan(beforeC);
  });

  it("renormalizes to integer gaps when a midpoint underflows REAL precision", async () => {
    const { parent } = await seedGoalParent("renorm");
    const [a, b, c] = await addSubtasks(parent.id, [
      { title: "A", effortMinutes: 5 },
      { title: "B", effortMinutes: 5 },
      { title: "C", effortMinutes: 5 },
    ]);
    // Wedge B and C into adjacent doubles so the next "before C" midpoint has no
    // representable value between them — the reorder must renormalize, not wedge.
    db.prepare("UPDATE tasks SET sort_order = ? WHERE id = ?").run(1, b.id);
    db.prepare("UPDATE tasks SET sort_order = ? WHERE id = ?").run(1 + Number.EPSILON, c.id);
    db.prepare("UPDATE tasks SET sort_order = ? WHERE id = ?").run(0.5, a.id);

    await reorder(a.id, c.id); // wants A between B and C — impossible without renorm

    // Order is correct and the siblings now sit on clean integer gaps again.
    expect(await childOrder(parent.id)).toEqual(["B", "A", "C"]);
    const orders = [sortOrderOf(b.id), sortOrderOf(a.id), sortOrderOf(c.id)];
    expect(orders).toEqual([1, 2, 3]);
  });

  it("is a coherent no-op-ish move when dropped just after itself (idempotent order)", async () => {
    const { parent } = await seedGoalParent("noop-ish");
    const [a, b, c] = await addSubtasks(parent.id, [
      { title: "A", effortMinutes: 5 },
      { title: "B", effortMinutes: 5 },
      { title: "C", effortMinutes: 5 },
    ]);
    // A before B — A is already before B, so the order stays A, B, C.
    await reorder(a.id, b.id);
    expect(await childOrder(parent.id)).toEqual(["A", "B", "C"]);
  });
});

describe("POST /api/tasks/:id/reorder — guards", () => {
  it("404s an unknown task or unknown beforeId", async () => {
    const { parent } = await seedGoalParent("guard-404");
    const [a] = await addSubtasks(parent.id, [{ title: "A", effortMinutes: 5 }]);
    await reorder(999999, null, 404);
    const res = await reorder(a.id, 999999, 404);
    expect(res.body.error).toMatch(/beforeId task not found/);
  });

  it("400s a cross-parent beforeId — that move is a reparent", async () => {
    const { parent: p1 } = await seedGoalParent("guard-cross-1");
    const { parent: p2 } = await seedGoalParent("guard-cross-2");
    const [a] = await addSubtasks(p1.id, [{ title: "A", effortMinutes: 5 }]);
    const [x] = await addSubtasks(p2.id, [{ title: "X", effortMinutes: 5 }]);
    const res = await reorder(a.id, x.id, 400);
    expect(res.body.error).toMatch(/sibling \(same parent\)/);
  });

  it("400s reordering a root task — root order is creation order", async () => {
    const { parent } = await seedGoalParent("guard-root");
    const res = await reorder(parent.id, null, 400);
    expect(res.body.error).toMatch(/not reorderable/);
  });

  it("400s placing a task before itself", async () => {
    const { parent } = await seedGoalParent("guard-self");
    const [a] = await addSubtasks(parent.id, [{ title: "A", effortMinutes: 5 }]);
    const res = await reorder(a.id, a.id, 400);
    expect(res.body.error).toMatch(/before itself/);
  });

  it("400s a malformed beforeId (missing, or not int/null)", async () => {
    const { parent } = await seedGoalParent("guard-shape");
    const [a] = await addSubtasks(parent.id, [{ title: "A", effortMinutes: 5 }]);
    await request(app).post(`/api/tasks/${a.id}/reorder`).send({}).expect(400);
    await request(app).post(`/api/tasks/${a.id}/reorder`).send({ beforeId: "nope" }).expect(400);
    await request(app).post(`/api/tasks/${a.id}/reorder`).send({ beforeId: 1.5 }).expect(400);
  });
});

describe("POST /api/tasks/:id/reorder — sequential queue interaction", () => {
  it("exposes the new first subtask to the draw pool after a reorder", async () => {
    const { goalId, parent } = await seedGoalParent("seq-expose");
    const [a, b, c] = await addSubtasks(
      parent.id,
      [
        { title: "seq A", effortMinutes: 5 },
        { title: "seq B", effortMinutes: 5 },
        { title: "seq C", effortMinutes: 5 },
      ],
      "sequential",
    );
    // Front step A is the only drawable card.
    for (let i = 0; i < 8; i++) expect((await draw(goalId)).task.id).toBe(a.id);

    // Drag C to the front → C is now the exposed step; A and B queue behind.
    await reorder(c.id, a.id);
    for (let i = 0; i < 8; i++) expect((await draw(goalId)).task.id).toBe(c.id);
    // The freed/held state is derived — no write to A or B was needed.
    const list = (await request(app).get("/api/tasks").expect(200)).body;
    const p = list.find((t: { id: number }) => t.id === parent.id);
    const held = Object.fromEntries(
      p.subtasks.map((s: { id: number; heldBack: number }) => [s.id, s.heldBack]),
    );
    expect(held[c.id]).toBe(0);
    expect(held[a.id]).toBe(1);
    expect(held[b.id]).toBe(1);
  });

  it("eagerly clears the persisted draw when a reorder strands it behind a new front step", async () => {
    const { goalId, parent } = await seedGoalParent("seq-strand");
    const [a, b] = await addSubtasks(
      parent.id,
      [
        { title: "strand A", effortMinutes: 5 },
        { title: "strand B", effortMinutes: 5 },
      ],
      "sequential",
    );
    // A is the exposed front and becomes the persisted current draw.
    expect((await draw(goalId)).task.id).toBe(a.id);
    expect(
      db.prepare("SELECT value FROM settings WHERE key = 'current_draw_task_id'").get(),
    ).toEqual({ value: String(a.id) });

    // Move B ahead of A → A is now held back, so the drawn card is stranded.
    await reorder(b.id, a.id);

    // EAGER: the pointer is gone before any GET /api/draw/current runs — a
    // later completion of B must not resurrect A.
    expect(
      db.prepare("SELECT value FROM settings WHERE key = 'current_draw_task_id'").get(),
    ).toBeUndefined();
    expect((await request(app).get("/api/draw/current").expect(200)).body).toBeNull();
  });

  it("keeps a still-drawable current draw when the reorder leaves it exposed", async () => {
    const { goalId, parent } = await seedGoalParent("seq-keep");
    const [a, b, c] = await addSubtasks(
      parent.id,
      [
        { title: "keep A", effortMinutes: 5 },
        { title: "keep B", effortMinutes: 5 },
        { title: "keep C", effortMinutes: 5 },
      ],
      "sequential",
    );
    expect((await draw(goalId)).task.id).toBe(a.id);

    // Reorder B and C behind each other — A stays the exposed front, so the
    // persisted draw survives (a sibling move that does not touch the front).
    await reorder(c.id, b.id);
    expect(
      db.prepare("SELECT value FROM settings WHERE key = 'current_draw_task_id'").get(),
    ).toEqual({ value: String(a.id) });
    expect((await request(app).get("/api/draw/current").expect(200)).body.task.id).toBe(a.id);
  });

  it("reordering a parallel parent's subtasks changes display order but keeps them all drawable", async () => {
    const { goalId, parent } = await seedGoalParent("par-reorder");
    const [a, b] = await addSubtasks(parent.id, [
      { title: "par A", effortMinutes: 5 },
      { title: "par B", effortMinutes: 5 },
    ]);
    await reorder(a.id, null); // A to the end → B, A
    expect(await childOrder(parent.id)).toEqual(["par B", "par A"]);
    // Both remain in the pool (parallel parent), unaffected by position.
    expect((await draw(goalId)).poolSize).toBe(2);
  });
});
