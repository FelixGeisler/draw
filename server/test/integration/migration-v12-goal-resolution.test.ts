import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type express from "express";
import { freshApp, testDb } from "../helpers.js";

// The v12 goals rebuild (#145, ADR-38) on a seeded v11 database. The rebuild
// is the one migration that DROPs a table with referencers, and its whole
// hazard is silent: with foreign_keys ON, DROP TABLE goals would fire
// tasks.goal_id's ON DELETE SET NULL (every task quietly unlinked) and
// materials.goal_id's ON DELETE CASCADE (every attachment quietly deleted) —
// and the migration would still "succeed". This file is the regression guard:
// goals in every legacy status, tasks linked to them, materials attached,
// then one boot, then the links are counted.

let app: express.Express;
let activeGoalId: number;
let achievedGoalId: number;
let droppedGoalId: number;

beforeAll(async () => {
  // Reconstruct the v11 schema: today's schema.sql minus only the v12 goal
  // changes (same strip the main chain test uses).
  const schemaPath = fileURLToPath(new URL("../../src/schema.sql", import.meta.url));
  const current = fs.readFileSync(schemaPath, "utf-8");
  const v11Schema = current
    .replace(
      /  -- Goal resolution[\s\S]*?status TEXT NOT NULL CHECK \(status IN \('active', 'achieved', 'missed', 'dropped'\)\) DEFAULT 'active',\r?\n/,
      "  status TEXT NOT NULL CHECK (status IN ('active', 'achieved', 'dropped')) DEFAULT 'active',\n",
    )
    .replace(/,\r?\n  resolved_at TEXT/, "")
    // v14 (#156): strip the draws table and the achievements claim columns so
    // this pre-v14 fixture does not already carry what the v14 migration adds.
    .replace(/-- Draw log[\s\S]*?CREATE TABLE draws[\s\S]*?\);\r?\n/, "")
    .replace(/,\r?\n  -- Claim-for-XP[\s\S]*?claim_xp INTEGER/, "");
  expect(v11Schema).not.toBe(current);
  expect(v11Schema).not.toContain("'missed'");
  expect(v11Schema).not.toContain("resolved_at");
  expect(v11Schema).not.toContain("CREATE TABLE draws");
  expect(v11Schema).not.toContain("claim_xp");

  const legacy = new Database(path.join(process.env.DATA_DIR!, "app.db"));
  legacy.exec(v11Schema);

  const insertGoal = legacy.prepare(
    "INSERT INTO goals (title, status, created_at) VALUES (?, ?, ?)",
  );
  const seedGoal = (title: string, status: string) =>
    Number(insertGoal.run(title, status, "2026-01-01T00:00:00.000Z").lastInsertRowid);
  activeGoalId = seedGoal("Still going", "active");
  achievedGoalId = seedGoal("Aced it", "achieved");
  droppedGoalId = seedGoal("Let go", "dropped");

  const insertTask = legacy.prepare(
    "INSERT INTO tasks (title, category_id, goal_id, created_at) VALUES (?, 1, ?, ?)",
  );
  for (const goalId of [activeGoalId, achievedGoalId, droppedGoalId]) {
    insertTask.run(`Task of goal ${goalId}`, goalId, "2026-01-02T00:00:00.000Z");
  }
  legacy
    .prepare(
      "INSERT INTO materials (goal_id, kind, note_text, created_at) VALUES (?, 'note', ?, ?)",
    )
    .run(achievedGoalId, "Chapters 3-5 were the key", "2026-01-03T00:00:00.000Z");

  legacy.pragma("user_version = 11");
  legacy.close();

  app = await freshApp(); // importing db.ts runs migrate() on the v11 file
});

describe("migration v11 → v12 rebuilds goals without firing FK actions (#145, ADR-38)", () => {
  it("runs the chain to the current version and leaves no scratch table", async () => {
    const db = await testDb();
    // 14, not 12: the boot always migrates to CURRENT_VERSION — v13 (#147)
    // deletes daily-hand rows this fixture never seeds, and v14 (#156) adds the
    // draws log + achievements claim columns.
    expect(db.pragma("user_version", { simple: true })).toBe(14);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'goals_new'").get(),
    ).toBeUndefined();
  });

  it("preserves every goal with its status verbatim and resolved_at NULL", async () => {
    const db = await testDb();
    const goals = db
      .prepare("SELECT id, title, status, resolved_at AS resolvedAt FROM goals ORDER BY id")
      .all() as { id: number; title: string; status: string; resolvedAt: string | null }[];
    expect(goals).toEqual([
      { id: activeGoalId, title: "Still going", status: "active", resolvedAt: null },
      { id: achievedGoalId, title: "Aced it", status: "achieved", resolvedAt: null },
      { id: droppedGoalId, title: "Let go", status: "dropped", resolvedAt: null },
    ]);
  });

  it("keeps every task linked — DROP TABLE did not fire the SET NULL", async () => {
    const db = await testDb();
    const linked = db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE goal_id IS NOT NULL")
      .get() as { n: number };
    expect(linked.n).toBe(3);
    // …and the links point where they did before the rebuild.
    const perGoal = db
      .prepare("SELECT goal_id AS goalId FROM tasks ORDER BY goal_id")
      .all() as { goalId: number }[];
    expect(perGoal.map((t) => t.goalId)).toEqual(
      [activeGoalId, achievedGoalId, droppedGoalId].sort((a, b) => a - b),
    );
  });

  it("keeps the materials — DROP TABLE did not fire the CASCADE", async () => {
    const db = await testDb();
    const materials = db
      .prepare("SELECT goal_id AS goalId, note_text AS noteText FROM materials")
      .all() as { goalId: number; noteText: string }[];
    expect(materials).toEqual([{ goalId: achievedGoalId, noteText: "Chapters 3-5 were the key" }]);
    // The API agrees (the count rides GOAL_SELECT's subquery).
    const listed = await request(app).get("/api/goals?status=achieved").expect(200);
    expect(listed.body[0].materialCount).toBe(1);
  });

  it("leaves no dangling reference behind the rebuild", async () => {
    const db = await testDb();
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("the migrated file accepts 'missed' and still 400s an unknown status", async () => {
    await request(app)
      .patch(`/api/goals/${activeGoalId}`)
      .send({ status: "missed" })
      .expect(200);
    await request(app).patch(`/api/goals/${activeGoalId}`).send({ status: "bogus" }).expect(400);
    // Back to active for any later reader — and reactivation clears the stamp.
    const reactivated = await request(app)
      .patch(`/api/goals/${activeGoalId}`)
      .send({ status: "active" })
      .expect(200);
    expect(reactivated.body.resolvedAt).toBeNull();
  });

  it("a pre-v12 achieved goal keeps its honest NULL across a status resend", async () => {
    // "Aced it" was achieved before resolved_at existed. A resend must not
    // mint a bogus resolution date (ADR-38: set only on the transition out of
    // 'active', kept verbatim otherwise).
    const resent = await request(app)
      .patch(`/api/goals/${achievedGoalId}`)
      .send({ status: "achieved" })
      .expect(200);
    expect(resent.body.status).toBe("achieved");
    expect(resent.body.resolvedAt).toBeNull();
  });
});
