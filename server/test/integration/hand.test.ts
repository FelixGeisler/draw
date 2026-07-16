import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import type Database from "better-sqlite3";
import { freshApp, testDb } from "../helpers.js";

// Daily hand (#59, ADR-34): POST /api/hand/deal deals today's plan out of the
// draw's OWN candidate pool, /play makes a card the current draw, and the hand
// shrinks — never grows — as its cards are resolved. One hand per local day,
// no redeal.
//
// The suite shares one database file-wide, so each scenario blocks the cards
// of the previous one out of the pool (`clearDeck`) and drops the internal
// hand/draw rows (`resetHandState`) — production never does either.

let app: express.Express;
let db: Database.Database;

beforeAll(async () => {
  app = await freshApp();
  db = await testDb();
});

async function seedGoal(title: string): Promise<number> {
  return (await request(app).post("/api/goals").send({ title }).expect(201)).body.id as number;
}

async function seedTask(
  title: string,
  effortMinutes: number | null,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  return (
    await request(app)
      .post("/api/tasks")
      .send({ title, categoryId: 1, effortMinutes, ...overrides })
      .expect(201)
  ).body;
}

/** Take every open task out of the deck, so a scenario's own cards are the
 *  entire pool. Blocking (not deleting) keeps earlier rows around as the
 *  negative evidence some cases below rely on. */
function clearDeck() {
  db.prepare("UPDATE tasks SET blocked = 1 WHERE status = 'open'").run();
}

/** Drop today's hand and any current draw — test plumbing, no product path. */
function resetHandState() {
  db.prepare(
    "DELETE FROM settings WHERE key IN ('daily_hand', 'current_draw_task_id', 'warmup_current_draw')",
  ).run();
}

function storedHand(): { date: string; taskIds: number[] } | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'daily_hand'").get() as
    | { value: string }
    | undefined;
  return row ? JSON.parse(row.value) : null;
}

/** Local calendar day, matching the server's local-day bucketing. */
function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const deal = async (status = 200) =>
  (await request(app).post("/api/hand/deal").send({}).expect(status)).body;
const getHand = async () => (await request(app).get("/api/hand").expect(200)).body;
const play = async (taskId: number, status = 200) =>
  (await request(app).post("/api/hand/play").send({ taskId }).expect(status)).body;
const titles = (hand: { tasks: { title: string }[] }) => hand.tasks.map((t) => t.title).sort();

beforeEach(() => {
  resetHandState();
  clearDeck();
});

describe("POST /api/hand/deal — dealing today's plan", () => {
  it("deals every fitting card and persists it as one settings row (no table)", async () => {
    await seedTask("hand A", 20);
    await seedTask("hand B", 25);
    await seedTask("hand C", 30);

    const res = await deal();
    expect(res.reason).toBeUndefined();
    expect(titles(res.hand)).toEqual(["hand A", "hand B", "hand C"]); // 75 <= 90
    expect(res.hand.budgetMinutes).toBe(90);
    expect(res.hand.date).toBe(localDay(new Date()));
    expect(storedHand()!.taskIds).toHaveLength(3);
  });

  it("caps the hand at the effort budget", async () => {
    await request(app).patch("/api/settings").send({ daily_hand_budget_minutes: 45 }).expect(200);
    for (const t of ["b1", "b2", "b3", "b4"]) await seedTask(t, 20);

    const res = await deal();
    // 20+20 = 40 fits, a third would make 60.
    expect(res.hand.tasks).toHaveLength(2);
    expect(res.hand.tasks.reduce((s: number, t: any) => s + t.effortMinutes, 0)).toBe(40);
    await request(app).patch("/api/settings").send({ daily_hand_budget_minutes: 90 }).expect(200);
  });

  it("caps the hand at five cards even when the budget could hold more", async () => {
    await request(app).patch("/api/settings").send({ daily_hand_budget_minutes: 500 }).expect(200);
    for (let i = 0; i < 9; i++) await seedTask(`cap ${i}`, 5);

    expect((await deal()).hand.tasks).toHaveLength(5);
    await request(app).patch("/api/settings").send({ daily_hand_budget_minutes: 90 }).expect(200);
  });

  it("does NOT stamp last_drawn_at — dealing is not drawing", async () => {
    const task = await seedTask("undealt", 20);
    await deal();
    const row = db.prepare("SELECT last_drawn_at AS lastDrawnAt FROM tasks WHERE id = ?").get(task.id) as {
      lastDrawnAt: string | null;
    };
    expect(row.lastDrawnAt).toBeNull();
  });

  it("does not touch the current draw, and awards no draw achievement", async () => {
    await seedTask("no side effects", 20);
    const before = await (await request(app).get("/api/gamification")).body;
    await deal();
    expect(await (await request(app).get("/api/draw/current")).body).toBeNull();
    const after = await (await request(app).get("/api/gamification")).body;
    expect(after.achievements.length).toBe(before.achievements.length);
  });

  it("a second deal on the same day is a 409 — one hand per day, and no redeal (ADR-34)", async () => {
    await seedTask("only hand", 20);
    await deal();
    const conflict = await deal(409);
    expect(conflict.error).toMatch(/already dealt/);
    // …and there is no redeal endpoint to fall back on.
    await request(app).post("/api/hand/redeal").send({}).expect(404);
  });

  it("the hand dies at local midnight: yesterday's row is no hand, and a fresh deal is allowed", async () => {
    const task = await seedTask("yesterday", 20);
    await deal();
    // Backdate the persisted hand by a day — the only honest way to simulate
    // the rollover without a clock injection the product does not have.
    const yesterday = new Date(Date.now() - 24 * 3_600_000);
    db.prepare("UPDATE settings SET value = ? WHERE key = 'daily_hand'").run(
      JSON.stringify({ date: localDay(yesterday), taskIds: [task.id] }),
    );

    expect(await getHand()).toBeNull(); // the ritual reset
    const fresh = await deal(); // …and dealing is open again
    expect(fresh.hand.date).toBe(localDay(new Date()));
  });
});

describe("POST /api/hand/deal — honest empty deals", () => {
  it("no_ready_tasks when the deck is empty", async () => {
    expect(await deal()).toEqual({ hand: null, reason: "no_ready_tasks" });
  });

  it("no_ready_tasks — not all_too_big — when the pool is only snoozed/blocked (ADR-17)", async () => {
    const blocked = await seedTask("blocked one", 10);
    await request(app).patch(`/api/tasks/${blocked.id}`).send({ blocked: true }).expect(200);
    const snoozed = await seedTask("snoozed one", 10);
    await request(app)
      .patch(`/api/tasks/${snoozed.id}`)
      .send({ deferredUntil: new Date(Date.now() + 3_600_000).toISOString() })
      .expect(200);
    expect(await deal()).toEqual({ hand: null, reason: "no_ready_tasks" });
  });

  it("all_too_big when everything left is oversized or unestimated", async () => {
    await seedTask("huge", 120);
    await seedTask("unestimated", null);
    expect(await deal()).toEqual({ hand: null, reason: "all_too_big" });
  });

  it("budget_too_small when eligible cards exist but none fits the budget", async () => {
    await request(app).patch("/api/settings").send({ daily_hand_budget_minutes: 5 }).expect(200);
    await seedTask("fits the deck, not the day", 30);

    // NOT all_too_big: the card is squarely in the deck (30 <= max_draw_effort
    // 30). It is the budget that cannot hold it, and that is one input away.
    expect(await deal()).toEqual({ hand: null, reason: "budget_too_small" });
    await request(app).patch("/api/settings").send({ daily_hand_budget_minutes: 90 }).expect(200);
  });
});

describe("POST /api/hand/deal — eligibility IS the draw's candidate pool", () => {
  it("never deals a snoozed, blocked, oversized, unestimated or container card", async () => {
    const eligible = await seedTask("the only eligible card", 20);
    const blocked = await seedTask("blocked", 10);
    await request(app).patch(`/api/tasks/${blocked.id}`).send({ blocked: true }).expect(200);
    await seedTask("too big", 120);
    await seedTask("unestimated", null);
    const snoozed = await seedTask("snoozed", 10);
    await request(app)
      .patch(`/api/tasks/${snoozed.id}`)
      .send({ deferredUntil: new Date(Date.now() + 3_600_000).toISOString() })
      .expect(200);
    // A container with an UNESTIMATED child: the parent is out as a container
    // (#111) and the child is out as unestimated, so neither muddies the
    // expectation. (An estimated child would be a perfectly dealable leaf.)
    const parent = await seedTask("container", 10);
    await request(app)
      .post(`/api/tasks/${parent.id}/subtasks`)
      .send({ subtasks: [{ title: "child", effortMinutes: null }] })
      .expect(201);

    const res = await deal();
    expect(res.hand.tasks.map((t: any) => t.id)).toEqual([eligible.id]);
  });

  it("inherits #23's sequential hold-back: only the front of the queue is dealt", async () => {
    const parent = await seedTask("sequential parent", null);
    await request(app)
      .post(`/api/tasks/${parent.id}/subtasks`)
      .send({
        subtasks: [
          { title: "step one", effortMinutes: 10 },
          { title: "step two", effortMinutes: 10 },
          { title: "step three", effortMinutes: 10 },
        ],
      })
      .expect(201);
    await request(app)
      .patch(`/api/tasks/${parent.id}`)
      .send({ subtaskOrderMode: "sequential" })
      .expect(200);

    // The budget (90) and the cap (5) would happily hold all three steps —
    // the hold-back predicate is the only thing keeping two of them out.
    expect(titles((await deal()).hand)).toEqual(["step one"]);
  });

  it("inherits #33's availability window: an out-of-window card is not dealt", async () => {
    // A window on a different weekday — always closed right now, in any zone.
    const closedDay = (new Date().getDay() + 1) % 7;
    await seedTask("scheduled for another day", 20, {
      windowDays: [closedDay],
      windowStart: "08:00",
      windowEnd: "12:00",
    });
    expect(await deal()).toEqual({ hand: null, reason: "all_outside_window" });
  });
});

describe("POST /api/hand/play — a played card IS the current draw", () => {
  it("plays a card: current draw, last_drawn_at stamped, drawn bonus on completion", async () => {
    const task = await seedTask("play me", 20, { impact: 3 });
    await deal();

    const played = await play(task.id);
    expect(played.task.id).toBe(task.id);
    expect((await request(app).get("/api/draw/current")).body.task.id).toBe(task.id);
    const row = db.prepare("SELECT last_drawn_at AS lastDrawnAt FROM tasks WHERE id = ?").get(task.id) as {
      lastDrawnAt: string | null;
    };
    expect(row.lastDrawnAt).not.toBeNull(); // playing stamps what dealing did not

    // The drawn bonus is derived from the current-draw pointer, so a played
    // card earns it with no new code path: round(20 × 3/3) × 1.5 = 30.
    const done = await request(app).patch(`/api/tasks/${task.id}`).send({ status: "done" }).expect(200);
    expect(done.body.xpAwarded).toBe(30);
    expect(done.body.bonus).toBeNull(); // a played card is drawn, never a warm-up
  });

  it("a played card is NOT marked a warm-up — it was gambled, so it keeps the ×1.5", async () => {
    const task = await seedTask("gambled", 20);
    await deal();
    await play(task.id);
    expect((await request(app).get("/api/draw/current")).body.warmup).toBeUndefined();
  });

  it("409 while another card is on the table — the hand is not a re-roll rack (#88)", async () => {
    const a = await seedTask("first", 20);
    const b = await seedTask("second", 20);
    await deal();
    await play(a.id);

    const conflict = await play(b.id, 409);
    expect(conflict.error).toMatch(/still in play/);
    // The standing card is untouched, and b was never stamped.
    expect((await request(app).get("/api/draw/current")).body.task.id).toBe(a.id);
    const row = db.prepare("SELECT last_drawn_at AS lastDrawnAt FROM tasks WHERE id = ?").get(b.id) as {
      lastDrawnAt: string | null;
    };
    expect(row.lastDrawnAt).toBeNull();
  });

  it("409 even for the card already in play — resolve it, do not re-deal it", async () => {
    const task = await seedTask("in play", 20);
    await deal();
    await play(task.id);
    await play(task.id, 409);
  });

  it("resolving the standing card frees the next play", async () => {
    const a = await seedTask("first up", 20);
    const b = await seedTask("next up", 20);
    await deal();
    await play(a.id);
    // "Not now" — the sanctioned escape (#19/ADR-17), which also takes the
    // snoozed card out of the hand (below).
    await request(app)
      .patch(`/api/tasks/${a.id}`)
      .send({ deferredUntil: new Date(Date.now() + 3_600_000).toISOString() })
      .expect(200);
    expect(await (await request(app).get("/api/draw/current")).body).toBeNull();
    expect((await play(b.id)).task.id).toBe(b.id);
  });

  it("404 when there is no hand, and when the card is not in it", async () => {
    const outsider = await seedTask("never dealt", 20);
    expect((await play(outsider.id, 404)).error).toMatch(/no hand/);

    await seedTask("dealt", 20);
    // Budget the hand down to one card so the outsider stays out of it.
    await request(app).patch("/api/settings").send({ daily_hand_budget_minutes: 20 }).expect(200);
    const hand = (await deal()).hand;
    const notDealt = hand.tasks[0].id === outsider.id ? null : outsider.id;
    if (notDealt != null) expect((await play(notDealt, 404)).error).toMatch(/not in today's hand/);
    await request(app).patch("/api/settings").send({ daily_hand_budget_minutes: 90 }).expect(200);
  });

  it("400 on a malformed taskId (#84: an honest shape error, never a 500)", async () => {
    await request(app).post("/api/hand/play").send({ taskId: "abc" }).expect(400);
    await request(app).post("/api/hand/play").send({}).expect(400);
  });

  it("a card that went stale after the deal cannot be played — it is pruned instead", async () => {
    const task = await seedTask("edited out of the deck", 20);
    await deal();
    // Edited too big while it sat in the hand: playing must not put a card
    // that is no longer in the deck on the table.
    await request(app).patch(`/api/tasks/${task.id}`).send({ effortMinutes: 300 }).expect(200);

    expect((await play(task.id, 404)).error).toMatch(/not in today's hand/);
    expect(await (await request(app).get("/api/draw/current")).body).toBeNull();
    expect(storedHand()!.taskIds).toEqual([]); // pruned permanently
  });
});

describe("GET /api/hand — lazy validation prunes stale members permanently (ADR-13)", () => {
  it("null when nothing was dealt today", async () => {
    expect(await getHand()).toBeNull();
  });

  it("prunes a card edited too big, and persists the shortened hand", async () => {
    const stale = await seedTask("grew too big", 20);
    const fine = await seedTask("still fine", 20);
    await deal();

    await request(app).patch(`/api/tasks/${stale.id}`).send({ effortMinutes: 300 }).expect(200);
    expect(titles(await getHand())).toEqual(["still fine"]);
    expect(storedHand()!.taskIds).toEqual([fine.id]); // permanent, not re-derived
  });

  it("prunes a card whose estimate was cleared, and one turned into a container", async () => {
    const unestimated = await seedTask("estimate cleared", 20);
    const container = await seedTask("broken down", 20);
    const survivor = await seedTask("survivor", 20);
    await deal();

    await request(app).patch(`/api/tasks/${unestimated.id}`).send({ effortMinutes: null }).expect(200);
    await request(app)
      .post(`/api/tasks/${container.id}/subtasks`)
      .send({ subtasks: [{ title: "a step", effortMinutes: 5 }] })
      .expect(201);

    expect(titles(await getHand())).toEqual(["survivor"]);
    expect(storedHand()!.taskIds).toEqual([survivor.id]);
  });

  it("prunes a card completed elsewhere (Tasks page, MCP, another tab)", async () => {
    const elsewhere = await seedTask("done elsewhere", 20);
    await seedTask("untouched", 20);
    await deal();

    await request(app).patch(`/api/tasks/${elsewhere.id}`).send({ status: "done" }).expect(200);
    expect(titles(await getHand())).toEqual(["untouched"]);
  });
});

describe("the hand shrinks eagerly where lazy validation cannot be trusted", () => {
  it("completing a card removes it from the hand — including a RECURRING one, which stays open", async () => {
    const recurring = await seedTask("water the plants", 20, { recurEveryDays: 3 });
    await seedTask("one-shot", 20);
    await deal();
    await play(recurring.id);

    const done = await request(app)
      .patch(`/api/tasks/${recurring.id}`)
      .send({ status: "done" })
      .expect(200);
    expect(done.body.task.status).toBe("open"); // recurrence keeps it open (ADR-6)…
    // …so only the EAGER removal can keep it out of the hand: it would sail
    // straight through isRestorable.
    expect(titles(await getHand())).toEqual(["one-shot"]);
    expect(storedHand()!.taskIds).not.toContain(recurring.id);
  });

  it("snoozing removes a card eagerly — the snooze wearing off must not resurrect it (ADR-17)", async () => {
    const snoozed = await seedTask("sent away", 20);
    await seedTask("kept", 20);
    await deal();

    const wake = new Date(Date.now() + 1_000).toISOString(); // wears off almost at once
    await request(app).patch(`/api/tasks/${snoozed.id}`).send({ deferredUntil: wake }).expect(200);
    expect(storedHand()!.taskIds).not.toContain(snoozed.id); // gone at PATCH time

    // Let the snooze expire: the card is drawable again — and still not in the
    // hand. Lazy validation alone would have handed it right back.
    db.prepare("UPDATE tasks SET deferred_until = ? WHERE id = ?").run(
      new Date(Date.now() - 1_000).toISOString(),
      snoozed.id,
    );
    const pool = await request(app).get("/api/draw/pool").expect(200);
    expect(pool.body.candidates.map((c: any) => c.id)).toContain(snoozed.id); // back in the deck
    expect(titles(await getHand())).toEqual(["kept"]); // but not back in the hand
  });

  it("blocking removes a card eagerly, and waking it does not bring it back", async () => {
    const blocked = await seedTask("blocked away", 20);
    await seedTask("stays", 20);
    await deal();

    await request(app).patch(`/api/tasks/${blocked.id}`).send({ blocked: true }).expect(200);
    expect(storedHand()!.taskIds).not.toContain(blocked.id);
    await request(app).patch(`/api/tasks/${blocked.id}`).send({ blocked: false }).expect(200);
    expect(titles(await getHand())).toEqual(["stays"]);
  });

  it("snoozing a hand card that was never played still removes it (not gated on the current draw)", async () => {
    const a = await seedTask("played one", 20);
    const b = await seedTask("never played", 20);
    await deal();
    await play(a.id); // a is the current draw; b is only in the hand

    await request(app).patch(`/api/tasks/${b.id}`).send({ blocked: true }).expect(200);
    expect(storedHand()!.taskIds).not.toContain(b.id);
    expect((await request(app).get("/api/draw/current")).body.task.id).toBe(a.id); // untouched
  });

  it("deleting a card prunes it eagerly — a freed id must not be re-bound into the hand", async () => {
    const doomed = await seedTask("delete me", 20);
    await seedTask("survives", 20);
    await deal();

    await request(app).delete(`/api/tasks/${doomed.id}`).expect(200);
    // Eager: the id is gone from the stored row BEFORE any GET runs. tasks.id
    // has no AUTOINCREMENT, so a later capture could re-bind this very id.
    expect(storedHand()!.taskIds).not.toContain(doomed.id);
    expect(titles(await getHand())).toEqual(["survives"]);
  });

  it("a subtask cascade-deleted with its parent is pruned too", async () => {
    const parent = await seedTask("parent", null);
    const created = (
      await request(app)
        .post(`/api/tasks/${parent.id}/subtasks`)
        .send({ subtasks: [{ title: "the child", effortMinutes: 10 }] })
        .expect(201)
    ).body;
    const childId = created[0].id;
    await deal();
    expect(storedHand()!.taskIds).toContain(childId);

    await request(app).delete(`/api/tasks/${parent.id}`).expect(200);
    expect(storedHand()!.taskIds).not.toContain(childId);
    expect(await getHand()).toEqual({
      date: localDay(new Date()),
      budgetMinutes: 90,
      tasks: [],
    });
  });
});

describe("the hand only ever shrinks — there is no way back in (ADR-34)", () => {
  it("an emptied hand does not re-deal, and reopening a completed card does not re-add it", async () => {
    const task = await seedTask("the whole plan", 20);
    await deal();
    await play(task.id);
    await request(app).patch(`/api/tasks/${task.id}`).send({ status: "done" }).expect(200);
    expect((await getHand()).tasks).toEqual([]);

    // Reopening restores the task to the deck (its completion is deleted)…
    await request(app).patch(`/api/tasks/${task.id}`).send({ status: "open" }).expect(200);
    const pool = await request(app).get("/api/draw/pool").expect(200);
    expect(pool.body.candidates.map((c: any) => c.id)).toContain(task.id);
    // …but today's plan is spent: an empty hand is still a hand, so no deal.
    expect((await getHand()).tasks).toEqual([]);
    await deal(409);
  });
});

describe("settings hygiene", () => {
  it("daily_hand_budget_minutes round-trips through /api/settings; the hand row never leaks", async () => {
    await seedTask("hidden state", 20);
    await deal();

    const settings = (await request(app).get("/api/settings").expect(200)).body;
    expect(settings.daily_hand_budget_minutes).toBe("90");
    // Internal session state, exactly like the current draw and the warm-up
    // marker: it has its own endpoint (GET /api/hand).
    expect(settings.daily_hand).toBeUndefined();
    expect(settings.current_draw_task_id).toBeUndefined();

    const patched = (
      await request(app).patch("/api/settings").send({ daily_hand_budget_minutes: 120 }).expect(200)
    ).body;
    expect(patched.daily_hand_budget_minutes).toBe("120");
    expect(patched.daily_hand).toBeUndefined();
    await request(app).patch("/api/settings").send({ daily_hand_budget_minutes: 90 }).expect(200);
  });

  it("rejects a non-positive-integer budget instead of dealing an empty hand later", async () => {
    for (const bad of [0, -30, 1.5, "abc", null]) {
      const res = await request(app)
        .patch("/api/settings")
        .send({ daily_hand_budget_minutes: bad })
        .expect(400);
      expect(res.error).toBeTruthy();
    }
    // …and the stored value is untouched by the rejected writes.
    expect((await request(app).get("/api/settings")).body.daily_hand_budget_minutes).toBe("90");
  });
});
