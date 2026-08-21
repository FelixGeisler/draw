import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const schemaPath = fileURLToPath(new URL("../../src/schema.sql", import.meta.url));
const currentSchema = fs.readFileSync(schemaPath, "utf-8");
const v17Schema = currentSchema
  .replace(/,\r?\n  gold_awarded INTEGER NOT NULL DEFAULT 0 CHECK \(gold_awarded >= 0\)/, "")
  .replace(/,\r?\n  claim_gold INTEGER CHECK \(claim_gold IS NULL OR claim_gold >= 0\)/, "")
  .replace(/CREATE INDEX idx_xp_ledger_reason ON xp_ledger\(reason\);\r?\n\r?\n/, "")
  .replace(/-- Empty v18 Gold effect ledger[\s\S]*?(?=CREATE TABLE achievement_customizations)/, "");

let database: Database.Database;

beforeAll(async () => {
  expect(v17Schema).not.toContain("gold_awarded");
  expect(v17Schema).not.toContain("claim_gold");
  expect(v17Schema).not.toContain("gold_ledger");
  expect(v17Schema).not.toContain("pack_openings");
  expect(v17Schema).not.toContain("idx_xp_ledger_reason");

  const legacy = new Database(path.join(process.env.DATA_DIR!, "app.db"));
  legacy.exec(v17Schema);
  const goal = legacy
    .prepare("INSERT INTO goals (title, created_at) VALUES ('v17 goal', ?)")
    .run("2026-08-20T00:00:00.000Z");
  const task = legacy
    .prepare(
      `INSERT INTO tasks
       (title, category_id, goal_id, impact, status, created_at, sort_order)
       VALUES ('v17 task', 1, ?, 4, 'done', ?, 7)`,
    )
    .run(goal.lastInsertRowid, "2026-08-20T01:00:00.000Z");
  legacy
    .prepare(
      `INSERT INTO completions
       (task_id, completed_at, was_drawn, xp_awarded, was_warmup)
       VALUES (?, ?, 1, 17, 0)`,
    )
    .run(task.lastInsertRowid, "2026-08-20T02:00:00.000Z");
  legacy
    .prepare(
      `INSERT INTO achievements (key, unlocked_at, claimed_at, claim_xp)
       VALUES ('first_completion', ?, ?, 23)`,
    )
    .run("2026-08-20T02:00:00.000Z", "2026-08-20T03:00:00.000Z");
  legacy
    .prepare("INSERT INTO streak_freezes (milestone_day, created_at) VALUES (?, ?)")
    .run("2026-08-20", "2026-08-20T03:00:00.000Z");
  const insertLedger = legacy.prepare(
    "INSERT INTO xp_ledger (amount, reason, ref, created_at) VALUES (?, ?, ?, ?)",
  );
  insertLedger.run(50, "challenge", "2026-08-20", "2026-08-20T04:00:00.000Z");
  insertLedger.run(-250, "buy:pack", "legacy-pack", "2026-08-20T05:00:00.000Z");
  legacy
    .prepare("INSERT INTO settings (key, value) VALUES ('owned_card_backs', ?)")
    .run('["classic","ember"]');
  legacy
    .prepare("INSERT INTO settings (key, value) VALUES ('equipped_card_back', 'ember')")
    .run();
  legacy.pragma("user_version = 17");
  legacy.close();

  ({ db: database } = await import("../../src/db.js"));
});

afterAll(() => {
  // Imported module owns the main test handle; Vitest tears it down with the process.
});

describe("v17 → v18 migration", () => {
  it("is the exact complete schema contract and applies owner defaults without rewrites", async () => {
    const { validateV18Contract } = await import("../../src/schemaV18.js");
    expect(database.pragma("user_version", { simple: true })).toBe(18);
    expect(() => validateV18Contract(database)).not.toThrow();
    expect(
      database
        .prepare(
          `SELECT title, goal_id AS goalId, impact, status, created_at AS createdAt, sort_order AS sortOrder
           FROM tasks WHERE title = 'v17 task'`,
        )
        .get(),
    ).toEqual({
      title: "v17 task",
      goalId: 1,
      impact: 4,
      status: "done",
      createdAt: "2026-08-20T01:00:00.000Z",
      sortOrder: 7,
    });
    expect(
      database
        .prepare("SELECT xp_awarded AS xp, gold_awarded AS gold FROM completions")
        .get(),
    ).toEqual({ xp: 17, gold: 0 });
    expect(
      database.prepare("SELECT claim_xp AS xp, claim_gold AS gold FROM achievements").get(),
    ).toEqual({ xp: 23, gold: null });
    expect(database.prepare("SELECT amount, reason, ref FROM xp_ledger ORDER BY id").all()).toEqual([
      { amount: 50, reason: "challenge", ref: "2026-08-20" },
      { amount: -250, reason: "buy:pack", ref: "legacy-pack" },
    ]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM gold_ledger").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM pack_openings").get()).toEqual({ count: 0 });
    expect(
      database.prepare("SELECT value FROM settings WHERE key = 'owned_card_backs'").get(),
    ).toEqual({ value: '["classic","ember"]' });
    expect(database.prepare("SELECT COUNT(*) AS count FROM streak_freezes").get()).toEqual({
      count: 1,
    });
  });

  it("derives permanent XP and unclamped Gold from only the approved facts", async () => {
    const { totalGold, totalXp, streakState } = await import(
      "../../src/services/gamificationService.js"
    );
    // 17 completion + 23 claim + 50 challenge; legacy buy:pack is stored but inert.
    expect(totalXp()).toBe(90);
    database
      .prepare("INSERT INTO xp_ledger (amount, reason, ref, created_at) VALUES (999, 'unknown', 'u1', ?)")
      .run("2026-08-20T06:00:00.000Z");
    database
      .prepare(
        "INSERT INTO xp_ledger (amount, reason, ref, created_at) VALUES (75, 'refund:duplicate', 'r1', ?)",
      )
      .run("2026-08-20T06:30:00.000Z");
    expect(totalXp()).toBe(90);

    const beforeHistoricalFreeze = streakState().freezesBanked;
    database
      .prepare("INSERT INTO xp_ledger (amount, reason, ref, created_at) VALUES (-500, 'buy:freeze', 'f1', ?)")
      .run(new Date().toISOString());
    expect(totalXp()).toBe(90);
    expect(streakState().freezesBanked).toBe(Math.min(2, beforeHistoricalFreeze + 1));

    database
      .prepare("INSERT INTO gold_ledger (amount, reason, ref, created_at) VALUES (-7, 'buy:pack', 'g1', ?)")
      .run("2026-08-20T08:00:00.000Z");
    database
      .prepare("INSERT INTO gold_ledger (amount, reason, ref, created_at) VALUES (2, 'refund:duplicate', 'g2', ?)")
      .run("2026-08-20T09:00:00.000Z");
    expect(totalGold()).toBe(-5);

    const beforeOpening = streakState().freezesBanked;
    database
      .prepare(
        `INSERT INTO pack_openings
         (ref, payment, back_key, rarity, duplicate, secret_chance_bp, effective_bonus, opened_at)
         VALUES ('opening-1', 'gold', 'classic', 'common', 0, 500, 'freeze', ?)`,
      )
      .run("2026-08-20T10:00:00.000Z");
    expect(streakState().freezesBanked).toBe(beforeOpening);
  });

  it("leaves a v17 schema/version intact when any v18 DDL statement fails", async () => {
    const failingPath = path.join(process.env.DATA_DIR!, "v17-forced-failure.db");
    const failing = new Database(failingPath);
    try {
      failing.exec(v17Schema);
      failing.exec("CREATE TABLE gold_ledger (collision INTEGER)");
      failing.pragma("user_version = 17");
      const { migrateDatabase } = await import("../../src/db.js");
      expect(() => migrateDatabase(failing)).toThrow(/gold_ledger already exists/);
      expect(failing.pragma("user_version", { simple: true })).toBe(17);
      expect(
        (failing.prepare("PRAGMA table_info(completions)").all() as { name: string }[]).some(
          (column) => column.name === "gold_awarded",
        ),
      ).toBe(false);
      expect(
        (failing.prepare("PRAGMA table_info(achievements)").all() as { name: string }[]).some(
          (column) => column.name === "claim_gold",
        ),
      ).toBe(false);
      expect(
        failing.prepare("SELECT sql FROM sqlite_master WHERE name = 'pack_openings'").get(),
      ).toBeUndefined();
    } finally {
      failing.close();
      fs.rmSync(failingPath, { force: true });
    }
  });
});

describe("fresh v18 schema", () => {
  it("starts empty at zero Gold/XP with no Ticket or miss counter", async () => {
    const freshPath = path.join(process.env.DATA_DIR!, "fresh-v18.db");
    const fresh = new Database(freshPath);
    try {
      const { migrateDatabase } = await import("../../src/db.js");
      const { validateV18Contract } = await import("../../src/schemaV18.js");
      migrateDatabase(fresh);
      expect(fresh.pragma("user_version", { simple: true })).toBe(18);
      expect(() => validateV18Contract(fresh)).not.toThrow();
      expect(
        fresh
          .prepare(
            `SELECT COALESCE((SELECT SUM(gold_awarded) FROM completions), 0)
                  + COALESCE((SELECT SUM(claim_gold) FROM achievements), 0)
                  + COALESCE((SELECT SUM(amount) FROM gold_ledger), 0) AS gold`,
          )
          .get(),
      ).toEqual({ gold: 0 });
      expect(
        fresh
          .prepare(
            `SELECT COALESCE((SELECT SUM(xp_awarded) FROM completions), 0)
                  + COALESCE((SELECT SUM(claim_xp) FROM achievements), 0)
                  + COALESCE((SELECT SUM(amount) FROM xp_ledger WHERE reason = 'challenge'), 0) AS xp`,
          )
          .get(),
      ).toEqual({ xp: 0 });
      expect(fresh.prepare("SELECT COUNT(*) AS count FROM gold_ledger").get()).toEqual({ count: 0 });
      expect(fresh.prepare("SELECT COUNT(*) AS count FROM pack_openings").get()).toEqual({ count: 0 });
      const names = (
        fresh.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view', 'index')").all() as {
          name: string;
        }[]
      ).map((row) => row.name);
      expect(names.filter((name) => /ticket|miss/i.test(name))).toEqual([]);
    } finally {
      fresh.close();
      fs.rmSync(freshPath, { force: true });
    }
  });
});
