import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import { freshApp, testDb } from "../helpers.js";

let app: express.Express;
beforeAll(async () => {
  app = await freshApp();
});

describe("task CRUD and breakdown rule", () => {
  it("creates a task and lists it with camelCase fields", async () => {
    const created = await request(app)
      .post("/api/tasks")
      .send({ title: "Prepare exam", categoryId: 2, effortMinutes: 60 })
      .expect(201);
    expect(created.body).toMatchObject({
      title: "Prepare exam",
      categoryId: 2,
      effortMinutes: 60,
      status: "open",
      impact: 3,
    });

    const list = await request(app).get("/api/tasks").expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].subtasks).toEqual([]);
  });

  it("rejects tasks without title or category", async () => {
    await request(app).post("/api/tasks").send({ categoryId: 1 }).expect(400);
    await request(app).post("/api/tasks").send({ title: "x" }).expect(400);
  });

  it("bulk-creates subtasks inheriting category and goal", async () => {
    const parent = (
      await request(app)
        .post("/api/tasks")
        .send({ title: "Big thing", categoryId: 1, effortMinutes: 90 })
    ).body;

    const subs = await request(app)
      .post(`/api/tasks/${parent.id}/subtasks`)
      .send({ subtasks: [{ title: "Step 1", effortMinutes: 15 }, { title: "Step 2", effortMinutes: 25 }] })
      .expect(201);

    expect(subs.body).toHaveLength(2);
    expect(subs.body[0]).toMatchObject({ categoryId: 1, parentId: parent.id });

    const list = await request(app).get("/api/tasks").expect(200);
    const listedParent = list.body.find((t: { id: number }) => t.id === parent.id);
    expect(listedParent.hasOpenChildren).toBe(1);
    expect(listedParent.subtasks).toHaveLength(2);
  });

  it("persists an optional per-subtask description and leaves it null when absent", async () => {
    const parent = (
      await request(app)
        .post("/api/tasks")
        .send({ title: "Probeklausur 2023", categoryId: 2, effortMinutes: 120 })
    ).body;

    const provenance = "Exercise 7 · 8 pts · ~45 min · Probeklausur_2023.pdf";
    const subs = await request(app)
      .post(`/api/tasks/${parent.id}/subtasks`)
      .send({
        subtasks: [
          { title: "Solve exercise 7", effortMinutes: 45, description: provenance },
          { title: "Solve exercise 8", effortMinutes: 20 },
        ],
      })
      .expect(201);

    expect(subs.body[0].description).toBe(provenance);
    expect(subs.body[1].description).toBeNull();

    // The description survives into the task list payload the client renders.
    const list = await request(app).get("/api/tasks").expect(200);
    const listed = list.body.find((t: { id: number }) => t.id === parent.id);
    expect(listed.subtasks.map((s: { description: string | null }) => s.description)).toEqual([
      provenance,
      null,
    ]);
  });

  it("keeps subtask creation transactional: one bad row rolls back the whole batch", async () => {
    const parent = (
      await request(app)
        .post("/api/tasks")
        .send({ title: "Atomic parent", categoryId: 1 })
    ).body;

    // Second row violates the impact CHECK constraint mid-transaction.
    await request(app)
      .post(`/api/tasks/${parent.id}/subtasks`)
      .send({ subtasks: [{ title: "would be created" }, { title: "constraint breaker", impact: 99 }] })
      .expect(500);

    const list = await request(app).get("/api/tasks").expect(200);
    const listed = list.body.find((t: { id: number }) => t.id === parent.id);
    expect(listed.subtasks).toEqual([]);
  });

  it("blocks completing a parent while subtasks are open (409)", async () => {
    const parent = (
      await request(app)
        .post("/api/tasks")
        .send({ title: "Blocked parent", categoryId: 1 })
    ).body;
    await request(app)
      .post(`/api/tasks/${parent.id}/subtasks`)
      .send({ subtasks: [{ title: "child" }] });

    await request(app).patch(`/api/tasks/${parent.id}`).send({ status: "done" }).expect(409);
  });

  it("completes normally and awards XP", async () => {
    const task = (
      await request(app)
        .post("/api/tasks")
        .send({ title: "Quick win", categoryId: 1, effortMinutes: 30, goalId: null })
    ).body;

    const done = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({ status: "done" })
      .expect(200);
    expect(done.body.task.status).toBe("done");
    expect(done.body.xpAwarded).toBe(30); // 30 min × (3/3)
    expect(done.body.recurring).toBe(false);
  });

  it("keeps recurring tasks open and pushes the due date forward", async () => {
    const chore = (
      await request(app)
        .post("/api/tasks")
        .send({ title: "Clean kitchen", categoryId: 3, effortMinutes: 20, recurEveryDays: 7 })
    ).body;

    const done = await request(app)
      .patch(`/api/tasks/${chore.id}`)
      .send({ status: "done" })
      .expect(200);

    expect(done.body.recurring).toBe(true);
    expect(done.body.task.status).toBe("open");
    const expected = new Date();
    expected.setDate(expected.getDate() + 7);
    expect(done.body.task.dueDate).toBe(expected.toISOString().slice(0, 10));
  });

  it("reopening removes the latest completion so XP cannot be farmed", async () => {
    const task = (
      await request(app)
        .post("/api/tasks")
        .send({ title: "Farmable?", categoryId: 1, effortMinutes: 10 })
    ).body;

    const xpBefore = (await request(app).get("/api/gamification")).body.xp;
    await request(app).patch(`/api/tasks/${task.id}`).send({ status: "done" });
    const xpAfterDone = (await request(app).get("/api/gamification")).body.xp;
    await request(app).patch(`/api/tasks/${task.id}`).send({ status: "open" });
    const xpAfterReopen = (await request(app).get("/api/gamification")).body.xp;

    expect(xpAfterDone).toBeGreaterThan(xpBefore);
    expect(xpAfterReopen).toBe(xpBefore);
  });

  it("derives remainingEffortMinutes from open subtasks, keeping stored effort intact", async () => {
    const parent = (
      await request(app)
        .post("/api/tasks")
        .send({ title: "Stale ninety", categoryId: 1, effortMinutes: 90 })
    ).body;
    await request(app)
      .post(`/api/tasks/${parent.id}/subtasks`)
      .send({ subtasks: [{ title: "First slice", effortMinutes: 15 }, { title: "Second slice", effortMinutes: 25 }] })
      .expect(201);

    const list = await request(app).get("/api/tasks").expect(200);
    const listed = list.body.find((t: { id: number }) => t.id === parent.id);
    expect(listed.remainingEffortMinutes).toBe(40);
    expect(listed.effortMinutes).toBe(90); // stored estimate untouched (edit forms prefill it)
  });

  it("completing a subtask shrinks the parent's remaining effort to the open ones", async () => {
    const parent = (
      await request(app)
        .post("/api/tasks")
        .send({ title: "Shrinking work", categoryId: 1, effortMinutes: 60 })
    ).body;
    const subs = (
      await request(app)
        .post(`/api/tasks/${parent.id}/subtasks`)
        .send({ subtasks: [{ title: "Done soon", effortMinutes: 20 }, { title: "Still open", effortMinutes: 10 }] })
    ).body;

    await request(app).patch(`/api/tasks/${subs[0].id}`).send({ status: "done" }).expect(200);

    let list = await request(app).get("/api/tasks").expect(200);
    let listed = list.body.find((t: { id: number }) => t.id === parent.id);
    expect(listed.remainingEffortMinutes).toBe(10);

    // All subtasks done: parent falls back to its own stored estimate.
    await request(app).patch(`/api/tasks/${subs[1].id}`).send({ status: "done" }).expect(200);
    list = await request(app).get("/api/tasks").expect(200);
    listed = list.body.find((t: { id: number }) => t.id === parent.id);
    expect(listed.remainingEffortMinutes).toBe(60);
  });

  it("returns null remaining effort when open subtasks are all unestimated", async () => {
    const parent = (
      await request(app)
        .post("/api/tasks")
        .send({ title: "Unsized breakdown", categoryId: 1, effortMinutes: 45 })
    ).body;
    await request(app)
      .post(`/api/tasks/${parent.id}/subtasks`)
      .send({ subtasks: [{ title: "No estimate yet" }, { title: "Also unsized" }] });

    const list = await request(app).get("/api/tasks").expect(200);
    const listed = list.body.find((t: { id: number }) => t.id === parent.id);
    expect(listed.remainingEffortMinutes).toBeNull(); // no fallback to the parent's own 45
  });

  it("sums only the estimated open subtasks when estimates are mixed", async () => {
    const parent = (
      await request(app)
        .post("/api/tasks")
        .send({ title: "Half sized", categoryId: 1, effortMinutes: 50 })
    ).body;
    await request(app)
      .post(`/api/tasks/${parent.id}/subtasks`)
      .send({ subtasks: [{ title: "Sized", effortMinutes: 12 }, { title: "Unsized" }] });

    const list = await request(app).get("/api/tasks").expect(200);
    const listed = list.body.find((t: { id: number }) => t.id === parent.id);
    expect(listed.remainingEffortMinutes).toBe(12);
  });

  it("leaf tasks report their own effort (or null) as remaining effort", async () => {
    const sized = (
      await request(app)
        .post("/api/tasks")
        .send({ title: "Sized leaf", categoryId: 1, effortMinutes: 25 })
    ).body;
    const unsized = (
      await request(app).post("/api/tasks").send({ title: "Unsized leaf", categoryId: 1 })
    ).body;

    const list = await request(app).get("/api/tasks").expect(200);
    const sizedListed = list.body.find((t: { id: number }) => t.id === sized.id);
    const unsizedListed = list.body.find((t: { id: number }) => t.id === unsized.id);
    expect(sizedListed.remainingEffortMinutes).toBe(25);
    expect(unsizedListed.remainingEffortMinutes).toBeNull();

    // Subtask entries in the payload are leaves too and carry their own effort.
    const parent = (
      await request(app)
        .post("/api/tasks")
        .send({ title: "Leaf check parent", categoryId: 1 })
    ).body;
    await request(app)
      .post(`/api/tasks/${parent.id}/subtasks`)
      .send({ subtasks: [{ title: "Leaf child", effortMinutes: 5 }] });
    const listed = (await request(app).get("/api/tasks")).body.find(
      (t: { id: number }) => t.id === parent.id,
    );
    expect(listed.subtasks[0].remainingEffortMinutes).toBe(5);
  });

  it("cascades a goal change on a broken-down parent to its subtasks", async () => {
    // Issue #17: goal counts and the goal-filtered draw key off each task
    // row's own goal_id, so attach/move/detach must reach the subtasks.
    const goalA = (
      await request(app).post("/api/goals").send({ title: "Cascade goal A" })
    ).body;
    const goalB = (
      await request(app).post("/api/goals").send({ title: "Cascade goal B" })
    ).body;
    const parent = (
      await request(app)
        .post("/api/tasks")
        .send({ title: "Broken-down attachee", categoryId: 1, effortMinutes: 60 })
    ).body;
    const subs = (
      await request(app)
        .post(`/api/tasks/${parent.id}/subtasks`)
        .send({ subtasks: [{ title: "Attach step 1", effortMinutes: 15 }, { title: "Attach step 2", effortMinutes: 20 }] })
    ).body;

    const goal = async (id: number) =>
      (await request(app).get("/api/goals")).body.find((g: { id: number }) => g.id === id);
    const listedParent = async () =>
      (await request(app).get("/api/tasks")).body.find((t: { id: number }) => t.id === parent.id);

    // Attach: subtasks follow, the goal counts all three rows...
    await request(app).patch(`/api/tasks/${parent.id}`).send({ goalId: goalA.id }).expect(200);
    let listed = await listedParent();
    expect(listed.goalId).toBe(goalA.id);
    expect(listed.subtasks.map((s: { goalId: number | null }) => s.goalId)).toEqual([goalA.id, goalA.id]);
    expect((await goal(goalA.id)).taskCount).toBe(3);

    // ...and the goal-filtered draw sees the ready subtasks (not an empty deck).
    const draw = (await request(app).post("/api/draw").send({ goalId: goalA.id }).expect(200)).body;
    expect(draw.task).not.toBeNull();
    expect(subs.map((s: { id: number }) => s.id)).toContain(draw.task.id);
    expect(draw.poolSize).toBe(2);

    // A patch without goalId leaves the links alone.
    await request(app).patch(`/api/tasks/${parent.id}`).send({ title: "Renamed attachee" }).expect(200);
    expect((await goal(goalA.id)).taskCount).toBe(3);

    // Move: nothing stays stranded on the old goal.
    await request(app).patch(`/api/tasks/${parent.id}`).send({ goalId: goalB.id }).expect(200);
    expect((await goal(goalA.id)).taskCount).toBe(0);
    expect((await goal(goalB.id)).taskCount).toBe(3);

    // Detach: subtasks are cleared too, not left pointing at goal B.
    await request(app).patch(`/api/tasks/${parent.id}`).send({ goalId: null }).expect(200);
    expect((await goal(goalB.id)).taskCount).toBe(0);
    listed = await listedParent();
    expect(listed.goalId).toBeNull();
    expect(listed.subtasks.map((s: { goalId: number | null }) => s.goalId)).toEqual([null, null]);
  });

  it("cascades a category change on a broken-down parent to its open subtasks (issue #44)", async () => {
    // Subtasks copy category_id at creation and the category-filtered draw
    // keys off each row's own category_id — moving the parent must reach the
    // open children or they keep drawing under the old category.
    const catA = (
      await request(app).post("/api/categories").send({ name: "Cascade cat A" }).expect(201)
    ).body;
    const catB = (
      await request(app).post("/api/categories").send({ name: "Cascade cat B" }).expect(201)
    ).body;
    const parent = (
      await request(app)
        .post("/api/tasks")
        .send({ title: "Category mover", categoryId: catA.id, effortMinutes: 60 })
    ).body;
    const subs = (
      await request(app)
        .post(`/api/tasks/${parent.id}/subtasks`)
        .send({
          subtasks: [
            { title: "Move step open", effortMinutes: 15 },
            { title: "Move step done", effortMinutes: 10 },
            { title: "Move step archived", effortMinutes: 10 },
          ],
        })
    ).body;
    // One finished, one archived BEFORE the move: history keeps the category
    // the work actually happened under — only open rows follow the parent.
    await request(app).patch(`/api/tasks/${subs[1].id}`).send({ status: "done" }).expect(200);
    await request(app).patch(`/api/tasks/${subs[2].id}`).send({ status: "archived" }).expect(200);

    await request(app).patch(`/api/tasks/${parent.id}`).send({ categoryId: catB.id }).expect(200);

    const listed = (await request(app).get("/api/tasks")).body.find(
      (t: { id: number }) => t.id === parent.id,
    );
    expect(listed.categoryId).toBe(catB.id);
    const bySub = (id: number) => listed.subtasks.find((s: { id: number }) => s.id === id);
    expect(bySub(subs[0].id).categoryId).toBe(catB.id); // open → follows
    expect(bySub(subs[1].id).categoryId).toBe(catA.id); // done → historical record
    // Archived rows are not listed — assert the column directly.
    const db = await testDb();
    const archived = db
      .prepare("SELECT category_id AS categoryId FROM tasks WHERE id = ?")
      .get(subs[2].id) as { categoryId: number };
    expect(archived.categoryId).toBe(catA.id);

    // The category-filtered draw only finds the subtask under the NEW
    // category; the old category's deck is empty, not stale.
    const oldDraw = (await request(app).post("/api/draw").send({ categoryId: catA.id }).expect(200))
      .body;
    expect(oldDraw.task).toBeNull();
    expect(oldDraw.reason).toBe("no_ready_tasks");
    const newDraw = (await request(app).post("/api/draw").send({ categoryId: catB.id }).expect(200))
      .body;
    expect(newDraw.task).not.toBeNull();
    expect(newDraw.task.id).toBe(subs[0].id);
    expect(newDraw.poolSize).toBe(1);

    // A patch that doesn't touch categoryId leaves the children alone.
    await request(app).patch(`/api/tasks/${parent.id}`).send({ title: "Category mover 2" }).expect(200);
    const after = (await request(app).get("/api/tasks")).body.find(
      (t: { id: number }) => t.id === parent.id,
    );
    expect(after.subtasks.map((s: { categoryId: number }) => s.categoryId)).toEqual([
      catB.id,
      catA.id,
    ]);
  });

  it("enforces the ADR-4 impact gate on create (issue #65)", async () => {
    // Non-neutral impact without a goal is rejected; nothing is created.
    await request(app)
      .post("/api/tasks")
      .send({ title: "Boosted chore", categoryId: 1, impact: 5 })
      .expect(400);
    const list = await request(app).get("/api/tasks").expect(200);
    expect(list.body.some((t: { title: string }) => t.title === "Boosted chore")).toBe(false);

    // The web form's goal-less payload (explicit neutral 3) still passes.
    await request(app)
      .post("/api/tasks")
      .send({ title: "Neutral chore", categoryId: 1, goalId: null, impact: 3 })
      .expect(201);

    // Out-of-range impact is a 400, not a raw constraint 500.
    await request(app)
      .post("/api/tasks")
      .send({ title: "Overrated", categoryId: 1, impact: 99 })
      .expect(400);
  });

  it("rejects an impact change on a goal-less task via PATCH (issue #65)", async () => {
    const task = (
      await request(app).post("/api/tasks").send({ title: "No-goal target", categoryId: 1 })
    ).body;

    const res = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({ impact: 5 })
      .expect(400);
    expect(res.body.error).toContain("ADR-4");

    const listed = (await request(app).get("/api/tasks")).body.find(
      (t: { id: number }) => t.id === task.id,
    );
    expect(listed.impact).toBe(3); // draw weight (impact²) stays honest

    // Adding the goal in the same patch makes the rating meaningful — accepted.
    const goal = (await request(app).post("/api/goals").send({ title: "Late-linked goal" })).body;
    const linked = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({ goalId: goal.id, impact: 5 })
      .expect(200);
    expect(linked.body.task.impact).toBe(5);
    expect(linked.body.task.goalId).toBe(goal.id);
  });

  it("keeps the edit form's no-op resend of a grandfathered impact working", async () => {
    // Goal deletion sets goal_id NULL but keeps the historical rating — the
    // edit form resends that stored impact verbatim (resolveSubmittedImpact),
    // and the gate must not reject or silently reset it.
    const goal = (await request(app).post("/api/goals").send({ title: "Doomed goal" })).body;
    const task = (
      await request(app)
        .post("/api/tasks")
        .send({ title: "Grandfathered", categoryId: 1, goalId: goal.id, impact: 5 })
    ).body;
    await request(app).delete(`/api/goals/${goal.id}`).expect(200);

    const edited = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({ title: "Grandfathered (renamed)", goalId: null, impact: 5 })
      .expect(200);
    expect(edited.body.task.impact).toBe(5);
    expect(edited.body.task.goalId).toBeNull();

    // A different rating on the still goal-less task stays forbidden...
    await request(app).patch(`/api/tasks/${task.id}`).send({ impact: 4 }).expect(400);
    // ...but an explicit reset to the neutral default is allowed.
    const reset = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({ impact: 3 })
      .expect(200);
    expect(reset.body.task.impact).toBe(3);
  });

  it("resets impact to the neutral default when the goal is unlinked", async () => {
    const goal = (await request(app).post("/api/goals").send({ title: "Unlink goal" })).body;
    const mk = async (title: string) =>
      (
        await request(app)
          .post("/api/tasks")
          .send({ title, categoryId: 1, goalId: goal.id, impact: 5 })
      ).body;

    // The web form unlinks with an explicit reset (resolveSubmittedImpact)...
    const viaClient = await mk("Unlink via form");
    const clientRes = await request(app)
      .patch(`/api/tasks/${viaClient.id}`)
      .send({ goalId: null, impact: 3 })
      .expect(200);
    expect(clientRes.body.task.impact).toBe(3);
    expect(clientRes.body.task.goalId).toBeNull();

    // ...and a bare unlink (MCP update_task, direct PATCH) gets the same
    // reset from the server: the rating pointed at the goal just removed.
    const viaApi = await mk("Unlink bare");
    const apiRes = await request(app)
      .patch(`/api/tasks/${viaApi.id}`)
      .send({ goalId: null })
      .expect(200);
    expect(apiRes.body.task.impact).toBe(3);

    // Unlinking while trying to keep a rating is contradictory — rejected,
    // and the task is untouched.
    const kept = await mk("Unlink but keep 5");
    await request(app)
      .patch(`/api/tasks/${kept.id}`)
      .send({ goalId: null, impact: 5 })
      .expect(400);
    const listed = (await request(app).get("/api/tasks")).body.find(
      (t: { id: number }) => t.id === kept.id,
    );
    expect(listed.impact).toBe(5);
    expect(listed.goalId).toBe(goal.id);
  });

  it("deletes a task with cascade to subtasks", async () => {
    const parent = (
      await request(app).post("/api/tasks").send({ title: "Doomed", categoryId: 1 })
    ).body;
    await request(app)
      .post(`/api/tasks/${parent.id}/subtasks`)
      .send({ subtasks: [{ title: "doomed child" }] });

    await request(app).delete(`/api/tasks/${parent.id}`).expect(200);
    const list = await request(app).get("/api/tasks?status=all").expect(200);
    expect(list.body.some((t: { title: string }) => t.title.startsWith("Doomed"))).toBe(false);
  });
});
