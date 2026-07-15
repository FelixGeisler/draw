import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import { freshApp } from "../helpers.js";

// Availability windows (#33, ADR-20): validation on POST/PATCH, pool
// inclusion/exclusion, empty-pool reason reporting, and the current-draw
// restore rejection. Windows are LOCAL wall-clock and no suite fakes the
// clock (matching the repo's convention of injecting NOW only at the unit
// level), so every window here is built RELATIVE to the test's real current
// time: today's weekday with a span comfortably around now for "inside",
// a different weekday for "outside" — robust at any time of day, where a
// time-of-day offset could clamp into an invalid range near midnight.

let app: express.Express;
beforeAll(async () => {
  app = await freshApp();
});

async function seed(task: Record<string, unknown>) {
  const res = await request(app).post("/api/tasks").send(task).expect(201);
  return res.body;
}

/** A window that contains the real "now", valid at any time of day. */
function openWindow() {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const fmt = (m: number) => {
    const c = Math.max(0, Math.min(1440, m));
    return `${String(Math.floor(c / 60)).padStart(2, "0")}:${String(c % 60).padStart(2, "0")}`;
  };
  return {
    windowDays: [now.getDay()],
    windowStart: fmt(minutes - 120),
    windowEnd: fmt(minutes + 120),
  };
}

/** The same span pinned to a different weekday — always excludes now. */
function closedWindow() {
  return { ...openWindow(), windowDays: [(new Date().getDay() + 1) % 7] };
}

describe("window validation on POST /api/tasks and PATCH /api/tasks/:id", () => {
  const base = { title: "w", categoryId: 1, effortMinutes: 10 };

  it("accepts a full window and returns windowDays parsed, deduplicated and sorted", async () => {
    const task = await seed({
      ...base,
      windowDays: [5, 1, 3, 1],
      windowStart: "08:00",
      windowEnd: "12:00",
    });
    expect(task.windowDays).toEqual([1, 3, 5]);
    expect(task.windowStart).toBe("08:00");
    expect(task.windowEnd).toBe("12:00");
  });

  it("allows 24:00 as end-of-day, so a full-day window is expressible", async () => {
    const task = await seed({ ...base, windowDays: [0], windowStart: "00:00", windowEnd: "24:00" });
    expect(task.windowEnd).toBe("24:00");
  });

  it("rejects a partial trio (all-or-none)", async () => {
    await request(app)
      .post("/api/tasks")
      .send({ ...base, windowDays: [1] })
      .expect(400);
    await request(app)
      .post("/api/tasks")
      .send({ ...base, windowStart: "08:00", windowEnd: "12:00" })
      .expect(400);
    await request(app)
      .post("/api/tasks")
      .send({ ...base, windowDays: [1], windowStart: "08:00" })
      .expect(400);
  });

  it("rejects invalid weekday sets", async () => {
    const times = { windowStart: "08:00", windowEnd: "12:00" };
    for (const windowDays of [[], [7], [-1], [1.5], ["1"], "12345", 1]) {
      await request(app).post("/api/tasks").send({ ...base, windowDays, ...times }).expect(400);
    }
  });

  it("rejects malformed times", async () => {
    for (const [windowStart, windowEnd] of [
      ["8:00", "12:00"], // not zero-padded
      ["08:00", "25:00"],
      ["08:60", "12:00"],
      ["24:00", "24:00"], // 24:00 is only valid as end, and end <= start anyway
      ["08:00", "1200"],
    ]) {
      await request(app)
        .post("/api/tasks")
        .send({ ...base, windowDays: [1], windowStart, windowEnd })
        .expect(400);
    }
  });

  it("rejects end <= start — overnight windows are the multi-window follow-up", async () => {
    await request(app)
      .post("/api/tasks")
      .send({ ...base, windowDays: [1], windowStart: "22:00", windowEnd: "02:00" })
      .expect(400);
    await request(app)
      .post("/api/tasks")
      .send({ ...base, windowDays: [1], windowStart: "08:00", windowEnd: "08:00" })
      .expect(400);
  });

  it("PATCH sets, revalidates, and windowDays: null clears all three", async () => {
    const task = await seed(base);
    const patched = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({ windowDays: [2, 4], windowStart: "09:00", windowEnd: "17:00" })
      .expect(200);
    expect(patched.body.task.windowDays).toEqual([2, 4]);

    // The same rules apply on edit…
    await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({ windowDays: [2], windowStart: "17:00", windowEnd: "09:00" })
      .expect(400);
    await request(app).patch(`/api/tasks/${task.id}`).send({ windowStart: "10:00" }).expect(400);

    // …and null clears the whole trio.
    const cleared = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({ windowDays: null })
      .expect(200);
    expect(cleared.body.task.windowDays).toBeNull();
    expect(cleared.body.task.windowStart).toBeNull();
    expect(cleared.body.task.windowEnd).toBeNull();
  });
});

describe("window as a draw-pool filter", () => {
  it("draws a task inside its window with unchanged weights, never one outside", async () => {
    const goal = (
      await request(app).post("/api/goals").send({ title: "window-pool" }).expect(201)
    ).body;
    const inside = await seed({
      title: "Inside window",
      categoryId: 1,
      goalId: goal.id,
      effortMinutes: 10,
      ...openWindow(),
    });
    await seed({
      title: "Outside window",
      categoryId: 1,
      goalId: goal.id,
      effortMinutes: 10,
      ...closedWindow(),
    });

    for (let i = 0; i < 10; i++) {
      const res = await request(app).post("/api/draw").send({ goalId: goal.id }).expect(200);
      expect(res.body.task.id).toBe(inside.id);
      // The window is a hard membership filter: the out-of-window card is
      // not merely down-weighted, it does not exist for the draw.
      expect(res.body.poolSize).toBe(1);
      expect(res.body.probability).toBe(1);
    }
  });

  it("an overdue out-of-window task stays excluded — urgency does not override the window", async () => {
    const goal = (
      await request(app).post("/api/goals").send({ title: "window-urgency" }).expect(201)
    ).body;
    await seed({
      title: "Overdue but closed",
      categoryId: 1,
      goalId: goal.id,
      effortMinutes: 10,
      dueDate: "2020-01-01",
      ...closedWindow(),
    });
    const res = await request(app).post("/api/draw").send({ goalId: goal.id }).expect(200);
    expect(res.body.task).toBeNull();
    expect(res.body.reason).toBe("all_outside_window");
  });

  it("GET /api/draw/pool applies the same filter (shared candidate query)", async () => {
    const goal = (
      await request(app).post("/api/goals").send({ title: "window-pool-endpoint" }).expect(201)
    ).body;
    await seed({
      title: "Pool inside",
      categoryId: 1,
      goalId: goal.id,
      effortMinutes: 10,
      ...openWindow(),
    });
    await seed({
      title: "Pool outside",
      categoryId: 1,
      goalId: goal.id,
      effortMinutes: 10,
      ...closedWindow(),
    });
    const res = await request(app).get(`/api/draw/pool?goalId=${goal.id}`).expect(200);
    expect(res.body.poolSize).toBe(1);
    expect(res.body.candidates.map((c: { title: string }) => c.title)).toEqual(["Pool inside"]);
  });
});

describe("empty-pool reason precedence (#33 decision 6)", () => {
  it("only out-of-window candidates → all_outside_window, not the misleading all_too_big", async () => {
    const goal = (
      await request(app).post("/api/goals").send({ title: "window-reason" }).expect(201)
    ).body;
    await seed({
      title: "Scheduled elsewhere",
      categoryId: 1,
      goalId: goal.id,
      effortMinutes: 10,
      ...closedWindow(),
    });
    const res = await request(app).post("/api/draw").send({ goalId: goal.id }).expect(200);
    expect(res.body.task).toBeNull();
    expect(res.body.reason).toBe("all_outside_window");
  });

  it("one oversized + one out-of-window → all_outside_window (the window card returns on its own)", async () => {
    const goal = (
      await request(app).post("/api/goals").send({ title: "window-reason-mixed" }).expect(201)
    ).body;
    await seed({ title: "Oversized", categoryId: 1, goalId: goal.id, effortMinutes: 120 });
    await seed({
      title: "Windowed",
      categoryId: 1,
      goalId: goal.id,
      effortMinutes: 10,
      ...closedWindow(),
    });
    const res = await request(app).post("/api/draw").send({ goalId: goal.id }).expect(200);
    expect(res.body.reason).toBe("all_outside_window");
  });

  it("a single task both oversized and out-of-window → all_too_big (waiting will not fix it)", async () => {
    const goal = (
      await request(app).post("/api/goals").send({ title: "window-reason-oversized" }).expect(201)
    ).body;
    await seed({
      title: "Oversized and windowed",
      categoryId: 1,
      goalId: goal.id,
      effortMinutes: 120,
      ...closedWindow(),
    });
    const res = await request(app).post("/api/draw").send({ goalId: goal.id }).expect(200);
    expect(res.body.reason).toBe("all_too_big");
  });

  it("keeps no_ready_tasks when nothing is open at all", async () => {
    const goal = (
      await request(app).post("/api/goals").send({ title: "window-reason-empty" }).expect(201)
    ).body;
    const res = await request(app).post("/api/draw").send({ goalId: goal.id }).expect(200);
    expect(res.body.reason).toBe("no_ready_tasks");
  });
});

describe("current-draw restore vs. the window (ADR-13, lazy clear)", () => {
  it("a drawn card edited out of its window is not restored after a reload", async () => {
    const goal = (
      await request(app).post("/api/goals").send({ title: "window-restore" }).expect(201)
    ).body;
    const task = await seed({
      title: "Drawn then windowed away",
      categoryId: 1,
      goalId: goal.id,
      effortMinutes: 10,
    });
    const drawn = await request(app).post("/api/draw").send({ goalId: goal.id }).expect(200);
    expect(drawn.body.task.id).toBe(task.id);

    const current = await request(app).get("/api/draw/current").expect(200);
    expect(current.body.task.id).toBe(task.id);

    await request(app).patch(`/api/tasks/${task.id}`).send(closedWindow()).expect(200);
    const after = await request(app).get("/api/draw/current").expect(200);
    expect(after.body).toBeNull();
  });

  it("a drawn card inside its window survives the reload", async () => {
    const goal = (
      await request(app).post("/api/goals").send({ title: "window-restore-open" }).expect(201)
    ).body;
    const window = openWindow();
    const task = await seed({
      title: "Drawn inside the window",
      categoryId: 1,
      goalId: goal.id,
      effortMinutes: 10,
      ...window,
    });
    const drawn = await request(app).post("/api/draw").send({ goalId: goal.id }).expect(200);
    expect(drawn.body.task.id).toBe(task.id);
    // The draw payload carries the parsed window for the client's badge.
    expect(drawn.body.task.windowDays).toEqual(window.windowDays);

    const current = await request(app).get("/api/draw/current").expect(200);
    expect(current.body.task.id).toBe(task.id);
  });
});
