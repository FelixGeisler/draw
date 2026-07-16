import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import type Database from "better-sqlite3";
import { freshApp, testDb } from "../helpers.js";

// Issue #111 (ADR-32): the parent-task lifecycle follows the subtasks.
// (1) effort — a parent with >= 1 non-archived subtask never uses its own
// stored estimate; (2) auto-complete — the last subtask closing completes an
// open, non-recurring parent through completeTask (symbolic 1 XP, archived
// ignored, recurring parents excluded); (3) reopen — every path that puts an
// open child under a done parent reopens it, deleting its latest completion
// row (ADR-5).

let app: express.Express;
let db: Database.Database;

beforeAll(async () => {
  app = await freshApp();
  db = await testDb();
});

async function mkGoal(title: string) {
  return (await request(app).post("/api/goals").send({ title })).body;
}

async function mkTask(body: Record<string, unknown>) {
  return (
    await request(app)
      .post("/api/tasks")
      .send({ categoryId: 1, ...body })
      .expect(201)
  ).body;
}

async function mkSubtasks(
  parentId: number,
  subtasks: Record<string, unknown>[],
  orderMode?: string,
) {
  return (
    await request(app)
      .post(`/api/tasks/${parentId}/subtasks`)
      .send(orderMode ? { subtasks, orderMode } : { subtasks })
      .expect(201)
  ).body;
}

async function patchTask(id: number, body: Record<string, unknown>, status = 200) {
  return (await request(app).patch(`/api/tasks/${id}`).send(body).expect(status)).body;
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

/**
 * Direct read — `listedTask` cannot see an archived SUBTASK by design (the
 * child listing filters status != 'archived'), and the #122 guard is about
 * exactly those rows.
 */
function statusOf(taskId: number) {
  return (db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string })
    .status;
}

function completionsOf(taskId: number) {
  return db
    .prepare(
      "SELECT was_drawn AS wasDrawn, was_warmup AS wasWarmup, xp_awarded AS xp FROM completions WHERE task_id = ? ORDER BY id",
    )
    .all(taskId) as { wasDrawn: number; wasWarmup: number; xp: number }[];
}

async function totalXp() {
  return (await request(app).get("/api/gamification").expect(200)).body.xp as number;
}

describe("the full lifecycle (the heart)", () => {
  it("break down → complete all → auto-done → add subtask → reopened → complete again → done again", async () => {
    const parent = await mkTask({ title: "Lifecycle parent", effortMinutes: 90 });
    const [a, b] = await mkSubtasks(parent.id, [
      { title: "lifecycle step a", effortMinutes: 10 },
      { title: "lifecycle step b", effortMinutes: 20 },
    ]);

    // Completing a NON-last subtask cascades nothing.
    const first = await patchTask(a.id, { status: "done" });
    expect(first.parentCompletion).toBeUndefined();
    expect((await listedTask(parent.id)).status).toBe("open");

    // The last subtask auto-completes the parent through completeTask: a
    // genuine completion row at the symbolic 1 XP (zero-effort floor), no
    // drawn bonus, surfaced on the subtask-completion response.
    const xpBefore = await totalXp();
    const last = await patchTask(b.id, { status: "done" });
    expect(last.task.status).toBe("done"); // the subtask itself
    expect(last.parentCompletion.task.id).toBe(parent.id);
    expect(last.parentCompletion.task.status).toBe("done");
    expect(last.parentCompletion.xpAwarded).toBe(1); // pinned: floor lifts round(0×impact/3) to 1
    expect(last.parentCompletion.bonus).toBeNull();
    expect(last.parentCompletion.recurring).toBe(false);

    const listed = await listedTask(parent.id);
    expect(listed.status).toBe("done");
    expect(listed.completedAt).not.toBeNull();
    expect(listed.effortMinutes).toBe(90); // stored estimate ignored, NOT nulled
    expect(listed.remainingEffortMinutes).toBeNull(); // never the parent's own 90
    expect(completionsOf(parent.id)).toEqual([{ wasDrawn: 0, wasWarmup: 0, xp: 1 }]);
    // b's 20 XP + the parent's symbolic 1 landed in the derived total.
    expect(await totalXp()).toBe(xpBefore + 20 + 1);

    // A genuine completion row counts for the daily goal like any other.
    const gamification = (await request(app).get("/api/gamification").expect(200)).body;
    expect(
      gamification.todayCompletions.some((c: { taskId: number }) => c.taskId === parent.id),
    ).toBe(true);

    // Adding a subtask (batch) reopens the parent and deletes its latest
    // completion row (ADR-5) — exactly the auto-completion undone.
    const [c] = await mkSubtasks(parent.id, [{ title: "lifecycle step c", effortMinutes: 5 }]);
    const reopened = await listedTask(parent.id);
    expect(reopened.status).toBe("open");
    expect(reopened.completedAt).toBeNull();
    expect(reopened.remainingEffortMinutes).toBe(5); // open child's sum, not 90
    expect(completionsOf(parent.id)).toEqual([]);
    expect(await totalXp()).toBe(xpBefore + 20); // the symbolic 1 was undone

    // Completing the fresh subtask closes the loop: auto-done again, a NEW
    // completion row.
    const again = await patchTask(c.id, { status: "done" });
    expect(again.parentCompletion.task.id).toBe(parent.id);
    expect((await listedTask(parent.id)).status).toBe("done");
    expect(completionsOf(parent.id)).toEqual([{ wasDrawn: 0, wasWarmup: 0, xp: 1 }]);

    // XP stays consistent with the completions log through the whole dance.
    const sum = db.prepare("SELECT COALESCE(SUM(xp_awarded), 0) AS xp FROM completions").get() as {
      xp: number;
    };
    expect(await totalXp()).toBe(sum.xp);
  });

  it("reopening a subtask reopens its done parent the same way (symmetry)", async () => {
    const parent = await mkTask({ title: "Symmetry parent", effortMinutes: 40 });
    const [a, b] = await mkSubtasks(parent.id, [
      { title: "symmetry step a", effortMinutes: 10 },
      { title: "symmetry step b", effortMinutes: 10 },
    ]);
    await patchTask(a.id, { status: "done" });
    await patchTask(b.id, { status: "done" });
    expect((await listedTask(parent.id)).status).toBe("done");
    expect(completionsOf(parent.id)).toHaveLength(1);

    await patchTask(a.id, { status: "open" });
    const reopened = await listedTask(parent.id);
    expect(reopened.status).toBe("open");
    expect(reopened.completedAt).toBeNull();
    expect(completionsOf(parent.id)).toEqual([]); // ADR-5: auto-completion undone
    // The subtask's own completion is gone too (the pre-existing reopen rule).
    expect(completionsOf(a.id)).toEqual([]);
  });
});

describe("reopen triggers on every create/adopt/revive path", () => {
  /** A done parent with one done subtask, built through the real lifecycle. */
  async function doneParent(tag: string) {
    const parent = await mkTask({ title: `Done parent ${tag}`, effortMinutes: 30 });
    const [sub] = await mkSubtasks(parent.id, [{ title: `done step ${tag}`, effortMinutes: 10 }]);
    await patchTask(sub.id, { status: "done" });
    expect((await listedTask(parent.id)).status).toBe("done");
    return { parent, sub };
  }

  it("single create (POST / with parentId) reopens a done parent", async () => {
    const { parent } = await doneParent("single");
    await mkTask({ title: "late arrival single", parentId: parent.id, effortMinutes: 5 });
    const listed = await listedTask(parent.id);
    expect(listed.status).toBe("open");
    expect(completionsOf(parent.id)).toEqual([]);
  });

  it("adoption via PATCH parentId reopens a done root (#104 item 1)", async () => {
    const { parent } = await doneParent("adopt");
    const stray = await mkTask({ title: "stray adoptee", effortMinutes: 5 });
    await patchTask(stray.id, { parentId: parent.id });
    const listed = await listedTask(parent.id);
    expect(listed.status).toBe("open");
    expect(completionsOf(parent.id)).toEqual([]);
  });

  it("adopting a DONE task does not reopen — only an open child arriving does", async () => {
    const { parent } = await doneParent("done-adopt");
    const finished = await mkTask({ title: "finished adoptee", effortMinutes: 5 });
    await patchTask(finished.id, { status: "done" });
    await patchTask(finished.id, { parentId: parent.id });
    // No open child appeared: the all-done state is intact, the parent stays
    // done and keeps its completion row.
    expect((await listedTask(parent.id)).status).toBe("done");
    expect(completionsOf(parent.id)).toHaveLength(1);
  });

  it("un-archiving a subtask under a done parent reopens it", async () => {
    const parent = await mkTask({ title: "Unarchive parent", effortMinutes: 30 });
    const [a, b] = await mkSubtasks(parent.id, [
      { title: "unarchive keeper", effortMinutes: 10 },
      { title: "unarchive comeback", effortMinutes: 10 },
    ]);
    await patchTask(b.id, { status: "archived" });
    await patchTask(a.id, { status: "done" }); // archived ignored → all-done → parent auto-done
    expect((await listedTask(parent.id)).status).toBe("done");

    await patchTask(b.id, { status: "open" }); // un-archive = open child under a done parent
    const listed = await listedTask(parent.id);
    expect(listed.status).toBe("open");
    expect(completionsOf(parent.id)).toEqual([]);
  });

  it("a legacy done parent without a completion row still reopens (undo is a no-op)", async () => {
    const parent = await mkTask({ title: "Legacy done parent", effortMinutes: 30 });
    const [sub] = await mkSubtasks(parent.id, [{ title: "legacy step", effortMinutes: 10 }]);
    await patchTask(sub.id, { status: "done" });
    db.prepare("DELETE FROM completions WHERE task_id = ?").run(parent.id); // hand-edited history
    await mkSubtasks(parent.id, [{ title: "legacy late step", effortMinutes: 5 }]);
    expect((await listedTask(parent.id)).status).toBe("open");
  });
});

// Issue #122 item 2: archived → done was the one status transition that
// reached the generic column write — no completeTask, no lifecycle hook.
describe("archived → done is rejected, not silently written (#122)", () => {
  it("a subtask cannot be completed straight out of the archive — no XP-less done row", async () => {
    const parent = await mkTask({ title: "Archived-to-done parent", effortMinutes: 30 });
    const [a, b] = await mkSubtasks(parent.id, [
      { title: "a2d keeper", effortMinutes: 10 },
      { title: "a2d archived", effortMinutes: 10 },
    ]);
    await patchTask(b.id, { status: "archived" });

    const rejected = await patchTask(b.id, { status: "done" }, 400);
    expect(rejected.error).toMatch(/archived task cannot be completed directly/);

    // Nothing was written: the row is still archived, still without a
    // completion — the XP-less done row the generic write used to mint.
    expect(statusOf(b.id)).toBe("archived");
    expect(completionsOf(b.id)).toEqual([]);
    // …and the parent never saw a phantom lifecycle event either: `a` is
    // still open, so the all-done predicate must not have fired.
    expect(statusOf(parent.id)).toBe("open");
    await patchTask(a.id, { status: "done" });
    expect(statusOf(parent.id)).toBe("done");
  });

  it("the same guard covers root tasks — the bypass was never subtask-specific", async () => {
    const root = await mkTask({ title: "Archived root", effortMinutes: 10 });
    await patchTask(root.id, { status: "archived" });
    await patchTask(root.id, { status: "done" }, 400);
    expect(statusOf(root.id)).toBe("archived");
    expect(completionsOf(root.id)).toEqual([]);
  });

  it("the prescribed repair works: un-archive, then complete — paying out exactly once", async () => {
    const root = await mkTask({ title: "Archived then revived", effortMinutes: 10 });
    await patchTask(root.id, { status: "archived" });
    await patchTask(root.id, { status: "open" });
    await patchTask(root.id, { status: "done" });
    expect(statusOf(root.id)).toBe("done");
    // One genuine completion through completeTask (ADR-5): 10 min × impact
    // 3/3, no drawn bonus — the XP the direct transition silently skipped.
    expect(completionsOf(root.id)).toHaveLength(1);
  });

  it("a no-op done → done resend still passes (the resend tolerance)", async () => {
    const root = await mkTask({ title: "Done resend", effortMinutes: 10 });
    await patchTask(root.id, { status: "done" });
    await patchTask(root.id, { status: "done" }); // 200, and no second payout
    expect(completionsOf(root.id)).toHaveLength(1);
  });

  it("archiving a DONE task stays legal — only the reverse direction is banned", async () => {
    const root = await mkTask({ title: "Done then archived", effortMinutes: 10 });
    await patchTask(root.id, { status: "done" });
    await patchTask(root.id, { status: "archived" });
    expect(statusOf(root.id)).toBe("archived");
  });
});

describe("archive interactions with the all-done predicate", () => {
  it("archiving the last open subtask next to a done sibling auto-completes the parent", async () => {
    const parent = await mkTask({ title: "Archive finisher", effortMinutes: 45 });
    const [a, b] = await mkSubtasks(parent.id, [
      { title: "archive done sibling", effortMinutes: 10 },
      { title: "archive dropout", effortMinutes: 10 },
    ]);
    await patchTask(a.id, { status: "done" });
    const res = await patchTask(b.id, { status: "archived" });
    expect(res.parentCompletion.task.id).toBe(parent.id);
    expect(res.parentCompletion.xpAwarded).toBe(1);
    expect((await listedTask(parent.id)).status).toBe("done");
  });

  it("archiving the ONLY subtask (no done sibling) leaves the parent an open leaf again", async () => {
    const parent = await mkTask({ title: "Archive-out parent", effortMinutes: 25 });
    const [only] = await mkSubtasks(parent.id, [{ title: "archived-away step", effortMinutes: 10 }]);
    const res = await patchTask(only.id, { status: "archived" });
    expect(res.parentCompletion).toBeUndefined(); // zero done subtasks → no all-done
    const listed = await listedTask(parent.id);
    expect(listed.status).toBe("open");
    // Zero non-archived children: PR #102 semantics — the stored estimate
    // is meaningful again for display and drawability.
    expect(listed.hasNonArchivedChildren).toBe(0);
    expect(listed.remainingEffortMinutes).toBe(25);
  });

  it("a split-in-place (#108) never auto-completes: archived original, open replacements", async () => {
    const parent = await mkTask({ title: "Split parent", effortMinutes: 80 });
    const [done, big] = await mkSubtasks(parent.id, [
      { title: "split done sibling", effortMinutes: 10 },
      { title: "split too big", effortMinutes: 60 },
    ]);
    await patchTask(done.id, { status: "done" });
    await request(app)
      .post(`/api/tasks/${big.id}/split`)
      .send({ parts: [{ title: "split part 1", effortMinutes: 30 }, { title: "split part 2", effortMinutes: 30 }] })
      .expect(201);
    const listed = await listedTask(parent.id);
    expect(listed.status).toBe("open"); // open parts arrived in the same transaction
    expect(completionsOf(parent.id)).toEqual([]);
    // The archived original is out of the rollup; the open parts are in.
    expect(listed.remainingEffortMinutes).toBe(60);
  });
});

describe("recurring parents are excluded from auto-complete (ADR-6 untouched)", () => {
  it("stays open when its last subtask closes; manual completion advances the recurrence at 1 XP", async () => {
    const parent = await mkTask({ title: "Recurring parent", effortMinutes: 20, recurEveryDays: 7 });
    const [a, b] = await mkSubtasks(parent.id, [
      { title: "recurring child a", effortMinutes: 5 },
      { title: "recurring child b", effortMinutes: 5 },
    ]);
    await patchTask(a.id, { status: "done" });
    const last = await patchTask(b.id, { status: "done" });
    expect(last.parentCompletion).toBeUndefined();
    const listed = await listedTask(parent.id);
    expect(listed.status).toBe("open");
    expect(completionsOf(parent.id)).toEqual([]);

    // Rule 1 covers it meanwhile: all-done breakdown, so the open recurring
    // parent is neither drawable nor showing its own estimate as remaining.
    const pool = (await request(app).get("/api/draw/pool").expect(200)).body;
    expect(pool.candidates.some((c: { id: number }) => c.id === parent.id)).toBe(false);
    expect(listed.remainingEffortMinutes).toBeNull();

    // Manual completion follows ADR-6 — due date advances, task stays open —
    // at the zero-effort XP (its breakdown already paid out), never its own 20.
    const manual = await patchTask(parent.id, { status: "done" });
    expect(manual.recurring).toBe(true);
    expect(manual.xpAwarded).toBe(1);
    expect(manual.task.status).toBe("open");
    const expected = new Date();
    expected.setDate(expected.getDate() + 7);
    expect(manual.task.dueDate).toBe(expected.toISOString().slice(0, 10));
  });

  it("a recurring SUBTASK never closes, so it never triggers the cascade either", async () => {
    const parent = await mkTask({ title: "Recurring-step parent", effortMinutes: 30 });
    const [a, b] = await mkSubtasks(parent.id, [
      { title: "one-shot sibling", effortMinutes: 5 },
      { title: "recurring step", effortMinutes: 5 },
    ]);
    await patchTask(b.id, { recurEveryDays: 3 });
    await patchTask(a.id, { status: "done" });
    const res = await patchTask(b.id, { status: "done" }); // ADR-6: stays open
    expect(res.recurring).toBe(true);
    expect(res.parentCompletion).toBeUndefined();
    expect((await listedTask(parent.id)).status).toBe("open");
  });
});

describe("manual completion parity (zero-effort XP)", () => {
  it("a parent manually completed in the all-done-open state earns 1 XP, never its own estimate — no drawn bonus", async () => {
    const parent = await mkTask({ title: "Legacy manual parent", effortMinutes: 90 });
    const [sub] = await mkSubtasks(parent.id, [{ title: "legacy manual step", effortMinutes: 10 }]);
    await patchTask(sub.id, { status: "done" }); // auto-done…
    await patchTask(parent.id, { status: "open" }); // …reopened by hand: all-done-open, like a legacy row
    expect((await listedTask(parent.id)).status).toBe("open");

    // Even a fresh last_drawn_at (pre-breakdown leftover) must not mint the
    // drawn ×1.5 on the symbolic completion — wasDrawn is forced false.
    db.prepare("UPDATE tasks SET last_drawn_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      parent.id,
    );
    const manual = await patchTask(parent.id, { status: "done" });
    expect(manual.xpAwarded).toBe(1);
    expect(completionsOf(parent.id)).toEqual([{ wasDrawn: 0, wasWarmup: 0, xp: 1 }]);
  });

  it("a parent whose subtasks are ALL archived completes as an ordinary leaf on its own estimate", async () => {
    const parent = await mkTask({ title: "All-archived parent", effortMinutes: 30 });
    const [only] = await mkSubtasks(parent.id, [{ title: "fully archived step", effortMinutes: 10 }]);
    await patchTask(only.id, { status: "archived" });
    const manual = await patchTask(parent.id, { status: "done" });
    expect(manual.xpAwarded).toBe(30); // 30 × (3/3) — zero non-archived children = leaf rules
  });
});

describe("sequential mode finale (ADR-18)", () => {
  it("completing the last held-back step auto-completes the parent — hold-back stays derived", async () => {
    const parent = await mkTask({ title: "Sequential finale parent", effortMinutes: 30 });
    const [s1, s2] = await mkSubtasks(
      parent.id,
      [
        { title: "finale step 1", effortMinutes: 10 },
        { title: "finale step 2", effortMinutes: 10 },
      ],
      "sequential",
    );
    expect((await listedTask(s2.id)).heldBack).toBe(1);
    await patchTask(s1.id, { status: "done" });
    expect((await listedTask(s2.id)).heldBack).toBe(0); // freed with no write
    const res = await patchTask(s2.id, { status: "done" });
    expect(res.parentCompletion.task.id).toBe(parent.id);
    expect((await listedTask(parent.id)).status).toBe("done");
  });
});

describe("current-draw pointer through the cascade (ADR-13)", () => {
  it("leaves no dangling pointer when the drawn last subtask completes the parent", async () => {
    const goal = await mkGoal("pointer goal");
    const parent = await mkTask({ title: "Pointer parent", goalId: goal.id, effortMinutes: 30 });
    const [only] = await mkSubtasks(parent.id, [{ title: "pointer last step", effortMinutes: 10 }]);

    const drawn = (await request(app).post("/api/draw").send({ goalId: goal.id }).expect(200)).body;
    expect(drawn.task.id).toBe(only.id); // the one drawable card in this goal

    const res = await patchTask(only.id, { status: "done" });
    expect(res.xpAwarded).toBe(15); // 10 × 1.5: the SUBTASK keeps its drawn bonus
    expect(res.parentCompletion.task.id).toBe(parent.id);

    // The subtask's own completeTask cleared the pointer; nothing dangles.
    expect((await request(app).get("/api/draw/current").expect(200)).body).toBeNull();
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'current_draw_task_id'")
      .get();
    expect(row).toBeUndefined();
  });
});

// Third case, deliberately NOT pinned as an exclusion (ADR-32): a parent with
// BOTH pre-breakdown tracked time AND a positive stored estimate DOES enter
// the block on auto-completion — the cycle is tracked and the estimate rule
// passes, exactly as the same row would have on manual completion. The data
// point is real and kept.
describe("estimation stats stay clean (ADR-15)", () => {
  it("a parent auto-completion never reaches the estimation block", async () => {
    // Parent A: stored estimate but NO tracked time → zero tracked cycles.
    const parentA = await mkTask({ title: "Estimation parent A", effortMinutes: 90 });
    const [subA] = await mkSubtasks(parentA.id, [{ title: "estimation step A", effortMinutes: 20 }]);
    // The subtask has tracked time and a positive estimate — IT qualifies.
    const now = Date.now();
    db.prepare("INSERT INTO time_entries (task_id, started_at, ended_at) VALUES (?, ?, ?)").run(
      subA.id,
      new Date(now - 30 * 60_000).toISOString(),
      new Date(now - 5 * 60_000).toISOString(),
    );
    await patchTask(subA.id, { status: "done" }); // parent A auto-done, untracked

    // Parent B: tracked time but NO estimate → excluded by the positive-
    // estimate rule even though its auto-completion attributes the cycle.
    const parentB = await mkTask({ title: "Estimation parent B" });
    const [subB] = await mkSubtasks(parentB.id, [{ title: "estimation step B", effortMinutes: 10 }]);
    db.prepare("INSERT INTO time_entries (task_id, started_at, ended_at) VALUES (?, ?, ?)").run(
      parentB.id,
      new Date(now - 60 * 60_000).toISOString(),
      new Date(now - 50 * 60_000).toISOString(),
    );
    await patchTask(subB.id, { status: "done" }); // parent B auto-done, tracked but unestimated

    const stats = (await request(app).get("/api/stats").expect(200)).body;
    const ids = stats.estimation.tasks.map((t: { taskId: number }) => t.taskId);
    expect(ids).toContain(subA.id);
    expect(ids).not.toContain(parentA.id);
    expect(ids).not.toContain(parentB.id);
  });
});

describe("rule 1: drawability and display without the parent's own estimate", () => {
  it("an all-done breakdown keeps the parent out of the deck and restore-invalid", async () => {
    // Reopen a lifecycle parent into the all-done-open state.
    const goal = await mkGoal("rule1 goal");
    const parent = await mkTask({ title: "Rule1 parent", goalId: goal.id, effortMinutes: 10 });
    const [sub] = await mkSubtasks(parent.id, [{ title: "rule1 step", effortMinutes: 10 }]);
    await patchTask(sub.id, { status: "done" });
    await patchTask(parent.id, { status: "open" }); // all-done-open, effort 10 ≤ max

    const listed = await listedTask(parent.id);
    expect(listed.hasOpenChildren).toBe(0);
    expect(listed.hasNonArchivedChildren).toBe(1);
    expect(listed.remainingEffortMinutes).toBeNull();

    // Not in the pool (its own 10-minute estimate is draw-inert)…
    const draw = (await request(app).post("/api/draw").send({ goalId: goal.id }).expect(200)).body;
    expect(draw.task).toBeNull();
    expect(draw.reason).toBe("no_ready_tasks");
    // …and not restorable either: a hand-planted pointer clears lazily.
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('current_draw_task_id', ?)").run(
      String(parent.id),
    );
    expect((await request(app).get("/api/draw/current").expect(200)).body).toBeNull();
  });

  it("the goal rollup never counts a broken-down parent's own estimate (all-done case)", async () => {
    const goal = await mkGoal("rollup goal");
    const parent = await mkTask({ title: "Rollup parent", goalId: goal.id, effortMinutes: 60 });
    const [sub] = await mkSubtasks(parent.id, [{ title: "rollup step", effortMinutes: 10 }]);
    await patchTask(sub.id, { status: "done" });
    await patchTask(parent.id, { status: "open" }); // all-done-open again
    const goals = (await request(app).get("/api/goals").expect(200)).body;
    const row = goals.find((g: { id: number }) => g.id === goal.id);
    expect(row.remainingOpenEffortMinutes).toBeNull(); // not the parent's 60
  });
});

describe("deleting a subtask triggers the lifecycle (the trash button is on every row)", () => {
  async function deleteTask(id: number) {
    return (await request(app).delete(`/api/tasks/${id}`).expect(200)).body;
  }

  it("deleting the last open subtask next to a done sibling auto-completes the parent", async () => {
    const parent = await mkTask({ title: "Delete-finisher parent", effortMinutes: 60 });
    const [done, irrelevant] = await mkSubtasks(parent.id, [
      { title: "delete-finisher done step", effortMinutes: 10 },
      { title: "delete-finisher irrelevant step", effortMinutes: 20 },
    ]);
    await patchTask(done.id, { status: "done" });
    expect((await listedTask(parent.id)).status).toBe("open"); // sibling still open

    // "This remaining step is irrelevant, delete it" finishes the breakdown:
    // same symbolic completion as the status-changing paths, same response
    // surface (parentCompletion), same transaction.
    const res = await deleteTask(irrelevant.id);
    expect(res.ok).toBe(true);
    expect(res.parentCompletion.task.id).toBe(parent.id);
    expect(res.parentCompletion.task.status).toBe("done");
    expect(res.parentCompletion.xpAwarded).toBe(1);
    expect((await listedTask(parent.id)).status).toBe("done");
    expect(completionsOf(parent.id)).toEqual([{ wasDrawn: 0, wasWarmup: 0, xp: 1 }]);
  });

  it("deleting a parent's ONLY subtask revives it as a leaf — children GONE, not done", async () => {
    const parent = await mkTask({ title: "Delete-only-child parent", effortMinutes: 45 });
    const [only] = await mkSubtasks(parent.id, [
      { title: "delete-only step", effortMinutes: 10 },
    ]);

    // Zero children left: the all-done predicate (>= 1 done subtask) cannot
    // fire — the parent stays open and its own estimate speaks again (PR #102).
    const res = await deleteTask(only.id);
    expect(res.parentCompletion).toBeUndefined();
    const listed = await listedTask(parent.id);
    expect(listed.status).toBe("open");
    expect(listed.hasNonArchivedChildren).toBe(0);
    expect(listed.remainingEffortMinutes).toBe(45); // leaf rules — own estimate
    expect(completionsOf(parent.id)).toEqual([]);
  });
});

describe("the warm-up marker never leaks into a symbolic completion (ADR-30)", () => {
  it("a broken-down warm-up card auto-completes with was_warmup = 0 and arms no momentum", async () => {
    // Test plumbing (mirrors warmup.test.ts): free the deal allowance and any
    // pointer earlier scenarios left behind — production never resets these.
    db.prepare(
      "DELETE FROM settings WHERE key IN ('warmup_last_dealt', 'warmup_current_draw', 'current_draw_task_id')",
    ).run();

    // Deal the smallest card of a dedicated goal, then break it down. The
    // breakdown does NOT clear the pointer (ADR-13 clears lazily on GET
    // /api/draw/current, which an MCP-driven flow may never hit), so the
    // marker still names the parent when the cascade completes it.
    const goal = await mkGoal("warmup leak goal");
    const parent = await mkTask({ title: "Warmup leak parent", goalId: goal.id, effortMinutes: 5 });
    const deal = (
      await request(app).post("/api/draw/warmup").send({ goalId: goal.id }).expect(200)
    ).body;
    expect(deal.task.id).toBe(parent.id);
    const [a, b] = await mkSubtasks(parent.id, [
      { title: "warmup leak step a", effortMinutes: 10 },
      { title: "warmup leak step b", effortMinutes: 10 },
    ]);

    // Complete the breakdown inside the bonus window (>= 15 minutes).
    await patchTask(a.id, { status: "done" });
    const last = await patchTask(b.id, { status: "done" });
    expect(last.parentCompletion.task.id).toBe(parent.id);
    expect(last.parentCompletion.xpAwarded).toBe(1);
    expect(last.parentCompletion.bonus).toBeNull(); // not "warmup"
    // The symbolic row is honest: the user never completed the dealt card.
    expect(completionsOf(parent.id)).toEqual([{ wasDrawn: 0, wasWarmup: 0, xp: 1 }]);
    // The parent's own completeTask cleared pointer and marker together.
    expect((await request(app).get("/api/draw/current").expect(200)).body).toBeNull();

    // No was_warmup row means hasMomentum() stays disarmed: a task completed
    // right afterwards earns plain XP (×1.25 would make this 13, bonus
    // "momentum").
    const probe = await mkTask({ title: "Momentum probe", effortMinutes: 10 });
    const plain = await patchTask(probe.id, { status: "done" });
    expect(plain.xpAwarded).toBe(10);
    expect(plain.bonus).toBeNull();
  });
});
