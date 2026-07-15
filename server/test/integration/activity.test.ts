import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import type Database from "better-sqlite3";
import { freshApp, testDb } from "../helpers.js";

// GET /api/activity (#53): per-local-day card derivation for the history
// skyline. Same-day flows go through the real API routes (create task, timer
// start/stop, PATCH done); multi-day scenarios backdate rows directly via
// testDb() — noon timestamps keep the local day unambiguous for any |offset|
// < 12h, and expected day strings come from the same local formatter the
// server uses.

let app: express.Express;
let db: Database.Database;

function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local noon, n days ago — an instant safely inside its local day. */
function noonDaysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(12, 0, 0, 0);
  return d;
}

const createTask = async (title: string, extra: Record<string, unknown> = {}) =>
  (
    await request(app)
      .post("/api/tasks")
      .send({ title, categoryId: 1, effortMinutes: 10, ...extra })
  ).body as { id: number };

const seedEntry = (taskId: number, startedAt: Date, minutes: number) =>
  db
    .prepare("INSERT INTO time_entries (task_id, started_at, ended_at) VALUES (?, ?, ?)")
    .run(taskId, startedAt.toISOString(), new Date(startedAt.getTime() + minutes * 60_000).toISOString());

const seedCompletion = (taskId: number, completedAt: Date, xp: number, wasDrawn = 0) =>
  db
    .prepare(
      "INSERT INTO completions (task_id, completed_at, was_drawn, xp_awarded) VALUES (?, ?, ?, ?)",
    )
    .run(taskId, completedAt.toISOString(), wasDrawn, xp);

const getDays = async (from: string, to: string) =>
  (await request(app).get(`/api/activity?from=${from}&to=${to}`).expect(200)).body.days as {
    date: string;
    cards: Record<string, unknown>[];
    totals: { started: number; completed: number; minutes: number; xp: number };
  }[];

beforeAll(async () => {
  app = await freshApp();
  db = await testDb();
});

describe("face-down permanence across days", () => {
  let essay: { id: number };

  beforeAll(async () => {
    essay = await createTask("write essay");
    // Worked 30 min two days ago, completed (drawn) yesterday.
    seedEntry(essay.id, noonDaysAgo(2), 30);
    seedCompletion(essay.id, noonDaysAgo(1), 15, 1);
  });

  it("keeps day D face-down and gives day D+1 the upright card", async () => {
    const from = localDay(noonDaysAgo(2));
    const to = localDay(noonDaysAgo(1));
    const days = await getDays(from, to);

    expect(days.map((d) => d.date)).toEqual([from, to]);

    const workedDay = days[0].cards.find((c) => c.taskId === essay.id);
    expect(workedDay).toMatchObject({
      title: "write essay",
      completed: false,
      trackedMinutes: 30,
      xpAwarded: 0,
      categoryColor: "#4f8cff",
      effortMinutes: 10,
    });

    const doneDay = days[1].cards.find((c) => c.taskId === essay.id);
    expect(doneDay).toMatchObject({
      completed: true,
      trackedMinutes: 0,
      xpAwarded: 15,
      wasDrawn: true,
    });
  });

  it("rolls the per-day totals for the #54 heatmap", async () => {
    const from = localDay(noonDaysAgo(2));
    const days = await getDays(from, localDay(noonDaysAgo(1)));
    expect(days[0].totals).toEqual({ started: 1, completed: 0, minutes: 30, xp: 0 });
    expect(days[1].totals).toEqual({ started: 1, completed: 1, minutes: 0, xp: 15 });
  });
});

describe("today via the real API routes", () => {
  it("gives a completion without any time entry an upright card (union rule)", async () => {
    const task = await createTask("done without timer");
    await request(app).patch(`/api/tasks/${task.id}`).send({ status: "done" }).expect(200);

    const today = localDay(new Date());
    const days = await getDays(today, today);
    const card = days[0].cards.find((c) => c.taskId === task.id);
    // 10 min effort × impact 3/3 → 10 XP through the real completion path
    expect(card).toMatchObject({ completed: true, trackedMinutes: 0, xpAwarded: 10 });
  });

  it("merges multiple entries into one card and counts a running entry up to now", async () => {
    const task = await createTask("timeboxed twice");
    // One closed 20-min entry this morning (backdated within today)...
    const morning = new Date();
    morning.setHours(0, 5, 0, 0); // 00:05 local is today for any wall clock
    seedEntry(task.id, morning, 20);
    // ...plus a live timer via the real route.
    await request(app).post(`/api/tasks/${task.id}/timer/start`).expect(200);

    const today = localDay(new Date());
    const days = await getDays(today, today);
    const cards = days[0].cards.filter((c) => c.taskId === task.id);
    expect(cards).toHaveLength(1); // per-(task, day) dedupe
    expect(cards[0].completed).toBe(false); // face-down while unfinished
    const tracked = cards[0].trackedMinutes as number;
    expect(tracked).toBeGreaterThanOrEqual(20); // running entry adds ≥ 0
    expect(tracked).toBeLessThanOrEqual(22);

    await request(app).post("/api/timer/stop").expect(200);
  });
});

describe("params and defaults", () => {
  it("defaults to an 8-week window ending today (local)", async () => {
    const res = await request(app).get("/api/activity").expect(200);
    const days = res.body.days;
    expect(days).toHaveLength(56);
    expect(days[55].date).toBe(localDay(new Date()));
  });

  it("accepts to-only and from-only", async () => {
    const res = await request(app).get("/api/activity?to=2026-01-31").expect(200);
    expect(res.body.days[55].date).toBe("2026-01-31");
    expect(res.body.days[0].date).toBe("2025-12-07");
  });

  it("rejects malformed and impossible dates", async () => {
    await request(app).get("/api/activity?from=garbage").expect(400);
    await request(app).get("/api/activity?from=2026-1-05&to=2026-01-31").expect(400);
    await request(app).get("/api/activity?from=2026-02-30&to=2026-03-01").expect(400);
    await request(app).get("/api/activity?to=2026-13-01").expect(400);
  });

  it("rejects from after to", async () => {
    await request(app).get("/api/activity?from=2026-01-05&to=2026-01-04").expect(400);
  });
});
