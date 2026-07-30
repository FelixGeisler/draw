import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import type Database from "better-sqlite3";
import { freshApp, testDb } from "../helpers.js";

// Achievement chains (#156): each level unlocks when a single running metric
// reaches its threshold, and the SAME table drives the progress bar. This file
// pins the two properties that matter:
//   * unlock at the EXACT threshold — seed the log to N-1 (locked) and N
//     (unlocked), for every metric (draws, completions, streak, level, goals,
//     hours);
//   * progress payload correctness — {current, target} on a chain card, null
//     on a one-off.
// checkAchievements is exercised directly so a threshold can be tested without
// the side effects of a real draw/completion shifting a neighbouring metric.

let app: express.Express;
let db: Database.Database;
let checkAchievements: (event: { completedTask?: unknown; drew?: boolean }) => string[];
let taskId: number;

beforeAll(async () => {
  app = await freshApp();
  db = await testDb();
  ({ checkAchievements } = (await import("../../src/services/gamificationService.js")) as unknown as {
    checkAchievements: (event: { completedTask?: unknown; drew?: boolean }) => string[];
  });
  taskId = Number(
    db
      .prepare("INSERT INTO tasks (title, category_id, impact, created_at) VALUES (?, 1, 3, ?)")
      .run("chain seed task", new Date().toISOString()).lastInsertRowid,
  );
});

/** Wipe every progress log and the unlock table, keeping the seed task. Each
 *  threshold block starts from a known-empty state on the shared DB. */
function resetProgress() {
  db.prepare("DELETE FROM achievements").run();
  db.prepare("DELETE FROM draws").run();
  db.prepare("DELETE FROM completions").run();
  db.prepare("DELETE FROM time_entries").run();
  db.prepare("DELETE FROM goals").run();
}

function isUnlocked(key: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM achievements WHERE key = ?").get(key));
}

async function progressOf(key: string): Promise<{ current: number; target: number } | null> {
  const g = (await request(app).get("/api/gamification")).body;
  return g.achievements.find((a: { key: string }) => a.key === key).progress;
}

function seedDraws(count: number, wasWarmup: 0 | 1) {
  const insert = db.prepare("INSERT INTO draws (task_id, drawn_at, was_warmup) VALUES (?, ?, ?)");
  for (let i = 0; i < count; i++) insert.run(taskId, new Date().toISOString(), wasWarmup);
}

function seedCompletions(count: number, xpEach = 1) {
  const insert = db.prepare(
    "INSERT INTO completions (task_id, completed_at, was_drawn, was_warmup, xp_awarded) VALUES (?, ?, 0, 0, ?)",
  );
  for (let i = 0; i < count; i++) insert.run(taskId, new Date().toISOString(), xpEach);
}

describe("draws chain — non-warmup only, exact threshold", () => {
  it("draw_10 is locked at 9 non-warmup draws and unlocks at 10", async () => {
    resetProgress();
    seedDraws(9, 0);
    checkAchievements({});
    expect(isUnlocked("draw_10")).toBe(false);
    expect(await progressOf("draw_10")).toEqual({ current: 9, target: 10 });

    seedDraws(1, 0); // → 10
    const fresh = checkAchievements({});
    expect(fresh).toContain("draw_10");
    expect(isUnlocked("draw_10")).toBe(true);
    expect(await progressOf("draw_10")).toEqual({ current: 10, target: 10 }); // capped at target
  });

  it("warm-up deals never advance the chain (ADR-30)", async () => {
    resetProgress();
    seedDraws(9, 0);
    seedDraws(50, 1); // 50 warm-up rows must not count
    checkAchievements({});
    expect(isUnlocked("draw_10")).toBe(false);
    expect(await progressOf("draw_10")).toEqual({ current: 9, target: 10 });
  });
});

describe("completions chain — exact threshold", () => {
  it("complete_25 is locked at 24 completions and unlocks at 25", async () => {
    resetProgress();
    seedCompletions(24);
    checkAchievements({});
    expect(isUnlocked("complete_25")).toBe(false);
    expect(await progressOf("complete_25")).toEqual({ current: 24, target: 25 });

    seedCompletions(1); // → 25
    expect(checkAchievements({})).toContain("complete_25");
    expect(isUnlocked("complete_25")).toBe(true);
  });
});

describe("streak chain — exact threshold", () => {
  /** Seed one completion at local noon on each of the last `days` days. */
  function seedStreakDays(days: number) {
    const insert = db.prepare(
      "INSERT INTO completions (task_id, completed_at, was_drawn, was_warmup, xp_awarded) VALUES (?, ?, 0, 0, 1)",
    );
    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setHours(12, 0, 0, 0);
      d.setDate(d.getDate() - i);
      insert.run(taskId, d.toISOString());
    }
  }

  it("streak_7 is locked at a 6-day run and unlocks at 7", async () => {
    resetProgress();
    seedStreakDays(6);
    // Sanity: the streak really reads 6.
    expect((await request(app).get("/api/gamification")).body.streak).toBe(6);
    checkAchievements({});
    expect(isUnlocked("streak_7")).toBe(false);
    expect(await progressOf("streak_7")).toEqual({ current: 6, target: 7 });

    resetProgress();
    seedStreakDays(7);
    expect((await request(app).get("/api/gamification")).body.streak).toBe(7);
    expect(checkAchievements({})).toContain("streak_7");
    expect(isUnlocked("streak_7")).toBe(true);
  });
});

describe("level chain — exact threshold", () => {
  it("level_5 is locked at level 4 (1702 XP) and unlocks at level 5 (1703 XP)", async () => {
    resetProgress();
    // A single completion carries the whole XP total — precise level control.
    const completionId = Number(
      db
        .prepare(
          "INSERT INTO completions (task_id, completed_at, was_drawn, was_warmup, xp_awarded) VALUES (?, ?, 0, 0, 1702)",
        )
        .run(taskId, new Date().toISOString()).lastInsertRowid,
    );
    expect((await request(app).get("/api/gamification")).body.level).toBe(4);
    checkAchievements({});
    expect(isUnlocked("level_5")).toBe(false);
    expect(await progressOf("level_5")).toEqual({ current: 4, target: 5 });

    db.prepare("UPDATE completions SET xp_awarded = 1703 WHERE id = ?").run(completionId);
    expect((await request(app).get("/api/gamification")).body.level).toBe(5);
    expect(checkAchievements({})).toContain("level_5");
    expect(isUnlocked("level_5")).toBe(true);
  });
});

describe("goals chain — exact threshold", () => {
  function seedAchievedGoals(count: number) {
    const insert = db.prepare(
      "INSERT INTO goals (title, status, created_at) VALUES (?, 'achieved', ?)",
    );
    for (let i = 0; i < count; i++) insert.run(`goal ${i}`, new Date().toISOString());
  }

  it("goals_5 is locked at 4 achieved goals and unlocks at 5", async () => {
    resetProgress();
    seedAchievedGoals(4);
    checkAchievements({});
    expect(isUnlocked("goals_5")).toBe(false);
    expect(await progressOf("goals_5")).toEqual({ current: 4, target: 5 });

    seedAchievedGoals(1); // → 5
    expect(checkAchievements({})).toContain("goals_5");
    expect(isUnlocked("goals_5")).toBe(true);
  });
});

describe("hours chain — exact threshold", () => {
  /** One closed time entry of `minutes` on the seed task, advancing only the
   *  tracked-hours metric the chain checks. */
  function seedTrackedMinutes(minutes: number) {
    const start = new Date();
    const end = new Date(start.getTime() + minutes * 60_000);
    db.prepare("INSERT INTO time_entries (task_id, started_at, ended_at) VALUES (?, ?, ?)").run(
      taskId,
      start.toISOString(),
      end.toISOString(),
    );
  }

  it("hours_10 is locked at 599 tracked minutes (9h) and unlocks at 600 (10h)", async () => {
    resetProgress();
    seedTrackedMinutes(599);
    checkAchievements({});
    expect(isUnlocked("hours_10")).toBe(false);
    expect(await progressOf("hours_10")).toEqual({ current: 9, target: 10 });

    resetProgress();
    seedTrackedMinutes(600);
    expect(checkAchievements({})).toContain("hours_10");
    expect(isUnlocked("hours_10")).toBe(true);
  });
});

describe("progress payload shape", () => {
  it("reports null progress for the event one-offs", async () => {
    for (const key of ["early_bird", "monster_slayer", "deck_clearer"]) {
      expect(await progressOf(key), key).toBeNull();
    }
  });

  it("reports {current, target} for every chain head and level", async () => {
    resetProgress();
    const g = (await request(app).get("/api/gamification")).body;
    // Log-based metrics sit at 0 after a reset; the level metric floors at 1
    // (level 1 is the 0-XP baseline), so it is asserted apart.
    const zeroBaselineKeys = [
      "first_draw",
      "draw_10000",
      "first_completion",
      "complete_2500",
      "streak_100",
      "first_goal",
      "goals_25",
      "hours_1000",
    ];
    for (const key of zeroBaselineKeys) {
      const card = g.achievements.find((a: { key: string }) => a.key === key);
      expect(card.progress, key).toMatchObject({ target: expect.any(Number) });
      expect(card.progress.current, key).toBe(0); // reset → nothing logged
    }
    // Level chain: current is the live level (1 at zero XP), target its rung.
    const level50 = g.achievements.find((a: { key: string }) => a.key === "level_50");
    expect(level50.progress).toEqual({ current: 1, target: 50 });
  });
});

// --- The #223 chains: drawn completions and completed steps -----------------

describe("drawn chain — gambled completions only, exact threshold (#223)", () => {
  function seedDrawnCompletions(count: number, wasWarmup: 0 | 1) {
    const insert = db.prepare(
      "INSERT INTO completions (task_id, completed_at, was_drawn, was_warmup, xp_awarded) VALUES (?, ?, 1, ?, 1)",
    );
    for (let i = 0; i < count; i++) insert.run(taskId, new Date().toISOString(), wasWarmup);
  }

  it("drawn_10 is locked at 9 drawn completions and unlocks at 10", async () => {
    resetProgress();
    seedDrawnCompletions(9, 0);
    checkAchievements({});
    expect(isUnlocked("drawn_10")).toBe(false);
    expect(await progressOf("drawn_10")).toEqual({ current: 9, target: 10 });

    seedDrawnCompletions(1, 0); // → 10
    const fresh = checkAchievements({});
    expect(fresh).toContain("drawn_10");
    expect(await progressOf("drawn_10")).toEqual({ current: 10, target: 10 });
  });

  it("warm-up completions do not count — dealt, not gambled (ADR-30)", async () => {
    resetProgress();
    seedDrawnCompletions(9, 0);
    seedDrawnCompletions(5, 1); // warm-ups: was_drawn but was_warmup
    checkAchievements({});
    expect(isUnlocked("drawn_10")).toBe(false);
    expect(await progressOf("drawn_10")).toEqual({ current: 9, target: 10 });
  });
});

describe("steps chain — completed subtasks, exact threshold (#223)", () => {
  let subtaskId: number;

  beforeAll(() => {
    subtaskId = Number(
      db
        .prepare(
          "INSERT INTO tasks (title, category_id, parent_id, impact, created_at) VALUES (?, 1, ?, 3, ?)",
        )
        .run("chain seed step", taskId, new Date().toISOString()).lastInsertRowid,
    );
  });

  function seedStepCompletions(count: number, ofTask: number) {
    const insert = db.prepare(
      "INSERT INTO completions (task_id, completed_at, was_drawn, was_warmup, xp_awarded) VALUES (?, ?, 0, 0, 1)",
    );
    for (let i = 0; i < count; i++) insert.run(ofTask, new Date().toISOString());
  }

  it("steps_10 is locked at 9 completed steps and unlocks at 10 — root completions never count", async () => {
    resetProgress();
    seedStepCompletions(9, subtaskId);
    seedStepCompletions(5, taskId); // ROOT completions: not steps
    checkAchievements({});
    expect(isUnlocked("steps_10")).toBe(false);
    expect(await progressOf("steps_10")).toEqual({ current: 9, target: 10 });

    seedStepCompletions(1, subtaskId); // → 10
    const fresh = checkAchievements({});
    expect(fresh).toContain("steps_10");
    expect(await progressOf("steps_10")).toEqual({ current: 10, target: 10 });
  });
});
