import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import type Database from "better-sqlite3";
import { freshApp, testDb } from "../helpers.js";

// Streak rest weekdays + freeze tokens (#58, ADR-28). Time-dependent state is
// seeded by backdating completions relative to the real "today" — rest
// weekdays are derived from the actual weekday of each backdated day, so the
// suite is deterministic on any day of the week.

let app: express.Express;
let db: Database.Database;
let seedTaskId: number;

/** Local calendar day n days before today, "YYYY-MM-DD". */
function localDay(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** ISO timestamp at local noon of the day n days ago — maps to that local day. */
function localNoon(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
}

function weekdayOf(offset: number): number {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return d.getDay();
}

function seedCompletion(offset: number) {
  db.prepare(
    "INSERT INTO completions (task_id, completed_at, was_drawn, xp_awarded) VALUES (?, ?, 0, 5)",
  ).run(seedTaskId, localNoon(offset));
}

async function gamification() {
  return (await request(app).get("/api/gamification").expect(200)).body;
}

beforeAll(async () => {
  app = await freshApp();
  db = await testDb();
  const task = (
    await request(app).post("/api/tasks").send({ title: "seed", categoryId: 1, effortMinutes: 5 })
  ).body;
  seedTaskId = task.id;
});

describe("GET /api/gamification — new streak fields", () => {
  it("exposes defaults on a fresh database", async () => {
    const g = await gamification();
    expect(g).toMatchObject({
      streak: 0,
      todayKind: "pending",
      freezesBanked: 0,
      freezeBankCap: 2,
      frozenDays: [],
      restDays: [],
    });
  });
});

describe("PATCH /api/settings — streak_rest_weekdays validation", () => {
  it("accepts a weekday subset, normalizes it, and persists it", async () => {
    const res = await request(app)
      .patch("/api/settings")
      .send({ streak_rest_weekdays: [6, 0, 6] }) // duplicates collapse, sorted
      .expect(200);
    expect(res.body.streak_rest_weekdays).toBe("[0,6]");
    const get = await request(app).get("/api/settings").expect(200);
    expect(get.body.streak_rest_weekdays).toBe("[0,6]");
  });

  it("accepts the empty set (default behavior)", async () => {
    const res = await request(app)
      .patch("/api/settings")
      .send({ streak_rest_weekdays: [] })
      .expect(200);
    expect(res.body.streak_rest_weekdays).toBe("[]");
  });

  it("rejects all 7 weekdays — a streak needs at least one required day", async () => {
    await request(app)
      .patch("/api/settings")
      .send({ streak_rest_weekdays: [0, 1, 2, 3, 4, 5, 6] })
      .expect(400);
  });

  it("rejects non-arrays and out-of-range weekdays", async () => {
    for (const bad of ["weekend", 6, { sat: true }, [7], [-1], [1.5], ["6"], null]) {
      await request(app).patch("/api/settings").send({ streak_rest_weekdays: bad }).expect(400);
    }
  });

  it("applies nothing else from a rejected request", async () => {
    const before = (await request(app).get("/api/settings").expect(200)).body;
    await request(app)
      .patch("/api/settings")
      .send({ max_draw_effort: 99, streak_rest_weekdays: [9] })
      .expect(400);
    const after = (await request(app).get("/api/settings").expect(200)).body;
    expect(after.max_draw_effort).toBe(before.max_draw_effort);
  });
});

describe("streak across rest weekdays, milestone earn, and achievement semantics", () => {
  // Run shape (offsets from today): 8,7 completed | 6,5 REST (missed) |
  // 4,3,2,1 completed | today completed via the API = 7 REAL days spanning 9
  // calendar days.
  const restA = weekdayOf(6);
  const restB = weekdayOf(5);

  it("a rest weekday without a completion neither breaks nor extends", async () => {
    await request(app)
      .patch("/api/settings")
      .send({ streak_rest_weekdays: [restA, restB] })
      .expect(200);
    for (const offset of [8, 7, 4, 3, 2, 1]) seedCompletion(offset);

    const g = await gamification();
    expect(g.streak).toBe(6); // real days only, unbroken across the rest gap
    expect(g.todayKind).toBe("pending");
    expect(g.restDays).toEqual([localDay(5), localDay(6)]);
    const streak7 = g.achievements.find((a: { key: string }) => a.key === "streak_7");
    expect(streak7.unlockedAt).toBeNull(); // 6 real days are not 7
  });

  it("the 7th real day unlocks streak_7 across the rest gap and earns a freeze", async () => {
    const res = await request(app)
      .patch(`/api/tasks/${seedTaskId}`)
      .send({ status: "done" })
      .expect(200);
    expect(res.body.newAchievements).toContain("streak_7");

    const g = await gamification();
    expect(g.streak).toBe(7);
    expect(g.todayKind).toBe("completed");
    expect(g.freezesBanked).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM streak_freezes").get()).toEqual({ n: 1 });
  });

  it("achievement copy reflects real-day semantics", async () => {
    const g = await gamification();
    const streak7 = g.achievements.find((a: { key: string }) => a.key === "streak_7");
    expect(streak7.description).toBe("7 completed days in one unbroken streak.");
  });

  it("complete → reopen → complete cannot farm the milestone (idempotent earn)", async () => {
    await request(app).patch(`/api/tasks/${seedTaskId}`).send({ status: "open" }).expect(200);
    // The undo removed today's completion, but the earn log is append-only.
    let g = await gamification();
    expect(g.streak).toBe(6);
    expect(g.freezesBanked).toBe(1);

    await request(app).patch(`/api/tasks/${seedTaskId}`).send({ status: "done" }).expect(200);
    g = await gamification();
    expect(g.streak).toBe(7); // crossed the milestone a second time...
    expect(g.freezesBanked).toBe(1); // ...but no second token
    expect(db.prepare("SELECT COUNT(*) AS n FROM streak_freezes").get()).toEqual({ n: 1 });
  });
});

describe("freeze consumption is derived at read time", () => {
  it("a token earned later cannot cover an earlier missed day", async () => {
    // Clearing the rest days turns offsets 6/5 into missed non-rest days.
    // The only banked token was earned TODAY — after the gap — so it must
    // not cover it: the streak breaks, and the token survives only because
    // it was earned after the break (tokens from before a break expire).
    await request(app).patch("/api/settings").send({ streak_rest_weekdays: [] }).expect(200);
    const g = await gamification();
    expect(g.streak).toBe(5); // today + offsets 1..4
    expect(g.freezesBanked).toBe(1);
    expect(g.frozenDays).toEqual([]);
  });

  it("a gap wider than the bank breaks the streak and the break expires the bank", async () => {
    // One token earned before the two-day gap: it covers the first missed
    // day, the second miss breaks the run, and the break expires everything
    // the dead run had banked (PR #98 review) — only today's token remains.
    db.prepare(
      "INSERT INTO streak_freezes (milestone_day, created_at) VALUES (?, ?)",
    ).run(localDay(8), localNoon(8));
    const g = await gamification();
    expect(g.streak).toBe(5);
    expect(g.freezesBanked).toBe(1);
    expect(g.frozenDays).toEqual([]);
  });

  it("banked tokens auto-cover the gap without extending the count", async () => {
    db.prepare(
      "INSERT INTO streak_freezes (milestone_day, created_at) VALUES (?, ?)",
    ).run(localDay(7), localNoon(7));
    const g = await gamification();
    // Two tokens earned before the gap bridge offsets 5+6: the full run
    // counts again.
    expect(g.streak).toBe(7);
    expect(g.frozenDays).toEqual([localDay(5), localDay(6)]);
    // 3 earned (today, -8, -7) minus 2 consumed — today's survives because
    // it could never cover days before it was earned.
    expect(g.freezesBanked).toBe(1);
  });

  it("GET /api/gamification has no observable write side effects", async () => {
    const counts = () => ({
      completions: db.prepare("SELECT COUNT(*) AS n FROM completions").get(),
      freezes: db.prepare("SELECT COUNT(*) AS n FROM streak_freezes").get(),
      settings: db.prepare("SELECT COUNT(*) AS n FROM settings").get(),
    });
    const before = counts();
    const first = await gamification();
    const second = await gamification();
    expect(counts()).toEqual(before);
    expect(second).toEqual(first); // derived reads are stable, not stateful
  });

  it("the milestone_day UNIQUE constraint holds (idempotence backstop)", async () => {
    expect(() =>
      db
        .prepare("INSERT INTO streak_freezes (milestone_day, created_at) VALUES (?, ?)")
        .run(localDay(8), localNoon(8)),
    ).toThrow(/UNIQUE/);
  });
});
