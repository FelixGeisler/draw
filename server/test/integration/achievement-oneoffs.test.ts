import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { freshApp, testDb } from "../helpers.js";
import { localDate, addDays } from "../../src/services/localDay.js";
import type { CompletionFacts, TaskRow } from "../../src/services/gamificationService.js";

// The #223 one-off conditions, exercised through checkAchievements directly —
// the achievement-chains.test.ts pattern, because holo_hunter / momentum /
// night_shift are properties of the completion EVENT (its drawn-ness, its
// bonus, its wall-clock instant), which a route-level test cannot vary at
// will. completeTask hands these facts over as `event.completion`; here they
// are crafted.

let db: Database.Database;
let checkAchievements: (event: {
  completedTask?: TaskRow;
  completion?: CompletionFacts;
}) => string[];
let taskRow: TaskRow;

/** A completion at LOCAL noon — a boring instant no condition triggers on. */
function noonFacts(overrides: Partial<CompletionFacts> = {}): CompletionFacts {
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  return { wasDrawn: false, wasWarmup: false, momentum: false, now: noon, ...overrides };
}

beforeAll(async () => {
  await freshApp();
  db = await testDb();
  ({ checkAchievements } = (await import(
    "../../src/services/gamificationService.js"
  )) as unknown as typeof import("../../src/services/gamificationService.js"));
  const id = Number(
    db
      .prepare("INSERT INTO tasks (title, category_id, impact, created_at) VALUES (?, 1, 5, ?)")
      .run("one-off seed", new Date().toISOString()).lastInsertRowid,
  );
  taskRow = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow;
});

beforeEach(() => {
  db.prepare("DELETE FROM achievements").run();
  db.prepare("DELETE FROM completions").run();
  db.prepare("DELETE FROM streak_freezes").run();
});

describe("holo_hunter — a gambled 5★ completion (#223)", () => {
  it("unlocks for drawn + impact 5, exactly the trophyRarity holo condition", () => {
    const fresh = checkAchievements({
      completedTask: taskRow,
      completion: noonFacts({ wasDrawn: true }),
    });
    expect(fresh).toContain("holo_hunter");
  });

  it("a warm-up deal is handed out, not gambled — no holo", () => {
    const fresh = checkAchievements({
      completedTask: taskRow,
      completion: noonFacts({ wasDrawn: true, wasWarmup: true }),
    });
    expect(fresh).not.toContain("holo_hunter");
  });

  it("an undrawn 5★ completion stays plain", () => {
    const fresh = checkAchievements({ completedTask: taskRow, completion: noonFacts() });
    expect(fresh).not.toContain("holo_hunter");
  });
});

describe("momentum — the ×1.25 condition, reused not re-derived (#223)", () => {
  it("unlocks exactly when completeTask computed the bonus condition", () => {
    expect(
      checkAchievements({ completedTask: taskRow, completion: noonFacts({ momentum: true }) }),
    ).toContain("momentum");
    db.prepare("DELETE FROM achievements").run();
    expect(
      checkAchievements({ completedTask: taskRow, completion: noonFacts() }),
    ).not.toContain("momentum");
  });
});

describe("well_rounded — completions across three categories (#223)", () => {
  it("stays locked at two distinct categories and unlocks at three", () => {
    const mkTask = (cat: number) =>
      Number(
        db
          .prepare("INSERT INTO tasks (title, category_id, created_at) VALUES (?, ?, ?)")
          .run(`cat-${cat}`, cat, new Date().toISOString()).lastInsertRowid,
      );
    const complete = (id: number) =>
      db
        .prepare(
          "INSERT INTO completions (task_id, completed_at, was_drawn, was_warmup, xp_awarded) VALUES (?, ?, 0, 0, 1)",
        )
        .run(id, new Date().toISOString());

    complete(mkTask(1));
    complete(mkTask(2));
    expect(
      checkAchievements({ completedTask: taskRow, completion: noonFacts() }),
    ).not.toContain("well_rounded");

    complete(mkTask(3));
    expect(
      checkAchievements({ completedTask: taskRow, completion: noonFacts() }),
    ).toContain("well_rounded");
  });
});

describe("night_shift — finished between 00:00 and 05:00 LOCAL (#223)", () => {
  it("unlocks at 01:30 local and not at 05:00 or noon", () => {
    const night = new Date();
    night.setHours(1, 30, 0, 0);
    expect(
      checkAchievements({ completedTask: taskRow, completion: noonFacts({ now: night }) }),
    ).toContain("night_shift");

    db.prepare("DELETE FROM achievements").run();
    const five = new Date();
    five.setHours(5, 0, 0, 0);
    expect(
      checkAchievements({ completedTask: taskRow, completion: noonFacts({ now: five }) }),
    ).not.toContain("night_shift");

    expect(
      checkAchievements({ completedTask: taskRow, completion: noonFacts() }),
    ).not.toContain("night_shift");
  });
});

describe("comeback — completing the day after a freeze saved the streak (#223)", () => {
  /** Local calendar day n days before today (streak-freeze.test.ts helper). */
  function localDay(offset: number): string {
    const d = new Date();
    d.setDate(d.getDate() - offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
  }
  function completionAtNoonOf(offset: number) {
    const d = new Date();
    d.setDate(d.getDate() - offset);
    d.setHours(12, 0, 0, 0);
    db.prepare(
      "INSERT INTO completions (task_id, completed_at, was_drawn, was_warmup, xp_awarded) VALUES (?, ?, 0, 0, 1)",
    ).run(taskRow.id, d.toISOString());
  }

  it("unlocks when yesterday was freeze-covered, not when the streak simply ran", () => {
    // Real days: ...-4, -3, -2 · GAP yesterday (-1) · a banked token earned
    // on -2 covers it. Rest weekdays default to none, so the gap is genuine.
    completionAtNoonOf(4);
    completionAtNoonOf(3);
    completionAtNoonOf(2);
    db.prepare("INSERT INTO streak_freezes (milestone_day, created_at) VALUES (?, ?)").run(
      localDay(2),
      new Date().toISOString(),
    );
    completionAtNoonOf(0); // today's completion — the comeback
    // Sanity: the fold really covers yesterday with the token.
    expect(localDate(new Date())).toBe(addDays(localDay(1), 1));

    const fresh = checkAchievements({ completedTask: taskRow, completion: noonFacts() });
    expect(fresh).toContain("comeback");
  });

  it("stays locked when yesterday was a plain streak day", () => {
    completionAtNoonOf(1);
    completionAtNoonOf(0);
    const fresh = checkAchievements({ completedTask: taskRow, completion: noonFacts() });
    expect(fresh).not.toContain("comeback");
  });
});
