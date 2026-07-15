import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import { freshApp, testDb } from "../helpers.js";

// Issue #84: the consolidated request-shape validation sweep. Every case in
// here used to surface as a raw 500 — a better-sqlite3 binding TypeError, a
// NOT NULL / FK / CHECK constraint violation, or `.map is not a function`
// inside an AI context builder — and is now a clean 400 that names the field.
// Plus the closed invariant hole: POST /api/tasks with parentId inherits the
// parent's goal and category exactly like the batch endpoint, so parent<->
// child goal divergence (PR #82's "third grandfathering path") can no longer
// be created.

let app: express.Express;
beforeAll(async () => {
  app = await freshApp();
});

const post = (body: Record<string, unknown>) => request(app).post("/api/tasks").send(body);

async function createTask(overrides: Record<string, unknown> = {}) {
  const res = await post({ title: "shape target", categoryId: 1, ...overrides }).expect(201);
  return res.body as { id: number; categoryId: number; goalId: number | null };
}

async function createGoal(title: string) {
  return (await request(app).post("/api/goals").send({ title }).expect(201)).body as {
    id: number;
  };
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

describe("POST /api/tasks request shapes (#84)", () => {
  it("rejects non-numeric effortMinutes with a 400 naming the field", async () => {
    for (const effortMinutes of ["abc", true, 2.5, 0, -5]) {
      const res = await post({ title: "bad effort", categoryId: 1, effortMinutes }).expect(400);
      expect(res.body.error).toContain("effortMinutes");
    }
    const list = await request(app).get("/api/tasks").expect(200);
    expect(list.body.some((t: { title: string }) => t.title === "bad effort")).toBe(false);
  });

  it("rejects a non-string description", async () => {
    for (const description of [{ nested: true }, 42, ["a"]]) {
      const res = await post({ title: "bad description", categoryId: 1, description }).expect(400);
      expect(res.body.error).toContain("description");
    }
  });

  it("rejects malformed dueDate and parentId shapes that used to be binding 500s", async () => {
    const badDate = await post({ title: "bad date", categoryId: 1, dueDate: {} }).expect(400);
    expect(badDate.body.error).toContain("dueDate");

    const badParent = await post({ title: "bad parent", categoryId: 1, parentId: {} }).expect(400);
    expect(badParent.body.error).toContain("parentId");
  });

  it("rejects a malformed or nonexistent categoryId instead of the FK 500", async () => {
    const shape = await post({ title: "cat shape", categoryId: "2" }).expect(400);
    expect(shape.body.error).toContain("categoryId");

    const missing = await post({ title: "cat missing", categoryId: 99999 }).expect(400);
    expect(missing.body.error).toContain("category not found");
  });

  it("rejects a malformed or nonexistent goalId instead of the FK 500", async () => {
    const shape = await post({ title: "goal shape", categoryId: 1, goalId: true }).expect(400);
    expect(shape.body.error).toContain("goalId");

    const missing = await post({ title: "goal missing", categoryId: 1, goalId: 99999 }).expect(400);
    expect(missing.body.error).toContain("goal not found");
  });
});

describe("POST /api/tasks/:id/subtasks request shapes (#84)", () => {
  it("rejects a non-numeric subtask effortMinutes, creating nothing", async () => {
    const parent = await createTask({ title: "batch effort parent" });
    const res = await request(app)
      .post(`/api/tasks/${parent.id}/subtasks`)
      .send({ subtasks: [{ title: "fine" }, { title: "breaker", effortMinutes: "45" }] })
      .expect(400);
    expect(res.body.error).toContain("effortMinutes");
    expect((await listedTask(parent.id)).subtasks).toEqual([]);
  });

  it("rejects a non-string subtask description, creating nothing (PR #82's old 500)", async () => {
    const parent = await createTask({ title: "batch description parent" });
    const res = await request(app)
      .post(`/api/tasks/${parent.id}/subtasks`)
      .send({ subtasks: [{ title: "fine" }, { title: "breaker", description: { nested: true } }] })
      .expect(400);
    expect(res.body.error).toContain("description");
    expect((await listedTask(parent.id)).subtasks).toEqual([]);
  });
});

describe("PATCH /api/tasks/:id request shapes (#84)", () => {
  it("rejects a null categoryId instead of the NOT NULL constraint 500 (PR #77)", async () => {
    const parent = await createTask({ title: "patch cat parent", categoryId: 2 });
    await request(app)
      .post(`/api/tasks/${parent.id}/subtasks`)
      .send({ subtasks: [{ title: "cascade child", effortMinutes: 5 }] })
      .expect(201);

    const res = await request(app)
      .patch(`/api/tasks/${parent.id}`)
      .send({ categoryId: null })
      .expect(400);
    expect(res.body.error).toContain("categoryId");

    // Neither the parent nor the cascade target moved.
    const listed = await listedTask(parent.id);
    expect(listed.categoryId).toBe(2);
    expect(listed.subtasks[0].categoryId).toBe(2);
  });

  it("rejects a nonexistent categoryId with 'category not found'", async () => {
    const task = await createTask({ title: "patch cat missing", categoryId: 2 });
    const res = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({ categoryId: 99999 })
      .expect(400);
    expect(res.body.error).toContain("category not found");
    expect((await listedTask(task.id)).categoryId).toBe(2);
  });

  it("rejects malformed field shapes that used to be binding or CHECK 500s", async () => {
    const task = await createTask({ title: "patch shapes" });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ effortMinutes: "abc" }, "effortMinutes"],
      [{ effortMinutes: 1.5 }, "effortMinutes"],
      [{ description: 9 }, "description"],
      [{ title: "" }, "title"],
      [{ title: 42 }, "title"],
      [{ status: "banana" }, "status"],
      [{ dueDate: {} }, "dueDate"],
      [{ goalId: "abc" }, "goalId"],
      [{ goalId: 99999 }, "goal not found"],
    ];
    for (const [body, needle] of cases) {
      const res = await request(app).patch(`/api/tasks/${task.id}`).send(body).expect(400);
      expect(res.body.error).toContain(needle);
    }
    // Clearing writes stay accepted (nullable columns).
    await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({ description: null, effortMinutes: null, dueDate: null })
      .expect(200);
  });
});

describe("recurEveryDays type normalization (#84, PR #81)", () => {
  it("coerces numeric strings on POST and rejects everything else non-null", async () => {
    const created = await post({
      title: "string recur",
      categoryId: 1,
      recurEveryDays: "3",
    }).expect(201);
    expect(created.body.recurEveryDays).toBe(3);

    for (const recurEveryDays of ["abc", true, 0, 1.5, "2.5"]) {
      const res = await post({ title: "bad recur", categoryId: 1, recurEveryDays }).expect(400);
      expect(res.body.error).toContain("recurEveryDays");
    }
  });

  it("coerces on PATCH so a string resend of the stored value stays the ADR-23 no-op", async () => {
    // Seed the pre-ban combination directly, like sequential-subtasks.test.ts:
    // a recurring step under a sequential parent is unreachable via the API.
    const parent = await createTask({ title: "legacy recur parent" });
    const [step] = (
      await request(app)
        .post(`/api/tasks/${parent.id}/subtasks`)
        .send({ orderMode: "sequential", subtasks: [{ title: "legacy step", effortMinutes: 5 }] })
        .expect(201)
    ).body;
    const db = await testDb();
    db.prepare("UPDATE tasks SET recur_every_days = 2 WHERE id = ?").run(step.id);

    // The stored value resent as a string used to read as a CHANGE under the
    // strict !== and hit the ADR-23 400; normalized, it is the tolerated no-op.
    const resend = await request(app)
      .patch(`/api/tasks/${step.id}`)
      .send({ recurEveryDays: "2" })
      .expect(200);
    expect(resend.body.task.recurEveryDays).toBe(2);

    // A genuine change stays banned on the sequential step...
    await request(app).patch(`/api/tasks/${step.id}`).send({ recurEveryDays: "3" }).expect(400);
    // ...and garbage is a shape 400, not a binding 500.
    const res = await request(app)
      .patch(`/api/tasks/${step.id}`)
      .send({ recurEveryDays: "soon" })
      .expect(400);
    expect(res.body.error).toContain("recurEveryDays");
  });
});

describe("AI route request shapes (#84) — validated before the key check, degraded mode", () => {
  it("estimate rejects malformed ids, materialIds and instruction with 400s", async () => {
    const none = await request(app).post("/api/ai/estimate").send({}).expect(400);
    expect(none.body.error).toContain("taskId or goalId");

    for (const body of [{ taskId: "1" }, { goalId: true }, { goalId: 0 }]) {
      await request(app).post("/api/ai/estimate").send(body).expect(400);
    }
    const mats = await request(app)
      .post("/api/ai/estimate")
      .send({ goalId: 1, materialIds: "abc" })
      .expect(400);
    expect(mats.body.error).toContain("materialIds");

    const instr = await request(app)
      .post("/api/ai/estimate")
      .send({ goalId: 1, instruction: 42 })
      .expect(400);
    expect(instr.body.error).toContain("instruction");

    // Well-shaped requests still hit the key gate — the degraded contract.
    await request(app).post("/api/ai/estimate").send({ goalId: 1, materialIds: [1] }).expect(503);
  });

  it("breakdown rejects malformed taskId and materialIds with 400s", async () => {
    await request(app).post("/api/ai/breakdown").send({ taskId: [] }).expect(400);
    const mats = await request(app)
      .post("/api/ai/breakdown")
      .send({ taskId: 1, materialIds: {} })
      .expect(400);
    expect(mats.body.error).toContain("materialIds");
    // materialIds must hold positive integers, not id-ish strings.
    await request(app).post("/api/ai/breakdown").send({ taskId: 1, materialIds: ["1"] }).expect(400);
    await request(app).post("/api/ai/breakdown").send({ taskId: 1, materialIds: [] }).expect(503);
  });

  it("plan-goal rejects malformed goalId, materialIds and userNotes with 400s", async () => {
    await request(app).post("/api/ai/plan-goal").send({ goalId: "g" }).expect(400);
    await request(app).post("/api/ai/plan-goal").send({ goalId: 1, materialIds: 3 }).expect(400);
    const notes = await request(app)
      .post("/api/ai/plan-goal")
      .send({ goalId: 1, userNotes: 42 })
      .expect(400);
    expect(notes.body.error).toContain("userNotes");
    await request(app).post("/api/ai/plan-goal").send({ goalId: 1, userNotes: "focus" }).expect(503);
  });

  it("generate-tasks rejects malformed goalId and materialIds with 400s", async () => {
    await request(app)
      .post("/api/ai/generate-tasks")
      .send({ goalId: 1.5, instruction: "import" })
      .expect(400);
    const mats = await request(app)
      .post("/api/ai/generate-tasks")
      .send({ goalId: 1, instruction: "import", materialIds: "abc" })
      .expect(400);
    expect(mats.body.error).toContain("materialIds");
  });
});

describe("POST /api/tasks with parentId inherits goal and category (#84)", () => {
  it("inherits the parent's goal and category; impact rates the inherited goal", async () => {
    const goal = await createGoal("Inheritance goal");
    const parent = await createTask({
      title: "Inheriting parent",
      categoryId: 2,
      goalId: goal.id,
      impact: 4,
    });

    // No categoryId, no goalId: both inherited — categoryId is only required
    // on root creates now.
    const child = (
      await post({ title: "Inheriting child", parentId: parent.id, impact: 5 }).expect(201)
    ).body;
    expect(child.goalId).toBe(goal.id);
    expect(child.categoryId).toBe(2);
    expect(child.impact).toBe(5); // ADR-4 judged against the INHERITED goal

    // The goal counts the child like a batch-created subtask.
    const listedGoal = (await request(app).get("/api/goals")).body.find(
      (g: { id: number }) => g.id === goal.id,
    );
    expect(listedGoal.taskCount).toBe(2);

    // Resending the parent's own values is a no-op, not divergence.
    await post({
      title: "Echoing child",
      parentId: parent.id,
      categoryId: 2,
      goalId: goal.id,
    }).expect(201);

    // Omitted impact defaults to the parent's rating — batch parity (the
    // single-create path used to fall back to the root create's neutral 3).
    const defaulted = (
      await post({ title: "Defaulting child", parentId: parent.id }).expect(201)
    ).body;
    expect(defaulted.impact).toBe(4);
  });

  it("rejects a divergent goalId — the PR #82 divergence can no longer be created", async () => {
    const goalless = await createTask({ title: "Goal-less parent" });
    const foreign = await createGoal("Foreign goal");

    // A child carrying its OWN goal under a goal-less parent broke the
    // invariant the goal cascade reasons from: the parent's next no-op
    // goalId resend would wipe the child's link without the ADR-4 impact
    // reset — the third grandfathering path this gate closes.
    const res = await post({
      title: "Divergent child",
      parentId: goalless.id,
      goalId: foreign.id,
    }).expect(400);
    expect(res.body.error).toContain("parent's goal");
    expect((await listedTask(goalless.id)).subtasks).toEqual([]);

    // Same gate when both have goals that differ.
    const linkedGoal = await createGoal("Linked goal");
    const linked = await createTask({ title: "Linked parent", goalId: linkedGoal.id });
    await post({ title: "Cross child", parentId: linked.id, goalId: foreign.id }).expect(400);
  });

  it("rejects a divergent categoryId (repair stays possible via subtask edit)", async () => {
    const parent = await createTask({ title: "Category parent", categoryId: 2 });
    const res = await post({
      title: "Wrong-category child",
      parentId: parent.id,
      categoryId: 1,
    }).expect(400);
    expect(res.body.error).toContain("parent's category");
    expect((await listedTask(parent.id)).subtasks).toEqual([]);
  });

  it("keeps the goal-less sibling-ranking impact exception batch-only (ADR-4, #76)", async () => {
    const parent = await createTask({ title: "Exception boundary parent" });

    // The batch accepts non-neutral impact under a goal-less parent...
    await request(app)
      .post(`/api/tasks/${parent.id}/subtasks`)
      .send({ subtasks: [{ title: "batch rated", impact: 5 }] })
      .expect(201);

    // ...the single-create path does not: its effective goal is the
    // inherited null, so the ordinary ADR-4 gate applies.
    const res = await post({ title: "single rated", parentId: parent.id, impact: 5 }).expect(400);
    expect(res.body.error).toContain("ADR-4");
  });
});
