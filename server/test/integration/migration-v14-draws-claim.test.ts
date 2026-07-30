import { beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freshApp, testDb } from "../helpers.js";

// Achievement chains + claim-for-XP (#156, ADR-42) land in migration v14 on a
// seeded pre-v14 (v13) database: a NEW append-only draws table, plus two
// nullable columns on the existing achievements table. This file is the
// regression guard for the three properties the design pins:
//   * the draws table exists with task_id ON DELETE SET NULL (never CASCADE) —
//     a draw HAPPENED even if the task is later deleted;
//   * the achievements claim columns backfill to NULL — a pre-#156 unlock reads
//     as "unlocked, unclaimed" (the launch-payday state);
//   * no data is lost: the seeded unlock survives the migration verbatim.

let seededTaskId: number;

beforeAll(async () => {
  // Reconstruct the v13 schema: today's schema.sql minus only the v14 draws
  // table and the achievements claim columns.
  const schemaPath = fileURLToPath(new URL("../../src/schema.sql", import.meta.url));
  const current = fs.readFileSync(schemaPath, "utf-8");
  const v13Schema = current
    // v15 (#157): strip the sort_order column and its stamp trigger so this
    // pre-v15 fixture does not already carry what the v15 migration adds.
    .replace(/,\r?\n  -- Stored sibling position[\s\S]*?sort_order REAL NOT NULL DEFAULT 0/, "")
    .replace(/-- Stamp sort_order[\s\S]*?END;\r?\n/, "")
    // v16 (#177): strip achievement_customizations so the forward migration re-adds it.
    .replace(
      /-- User-customizable achievement display metadata[\s\S]*?CREATE TABLE achievement_customizations[\s\S]*?\);\r?\n\r?\n/,
      "",
    )
    .replace(/-- Draw log[\s\S]*?CREATE TABLE draws[\s\S]*?\);\r?\n/, "")
    .replace(/,\r?\n  -- Claim-for-XP[\s\S]*?claim_xp INTEGER/, "");
  expect(v13Schema).not.toBe(current);
  expect(v13Schema).not.toContain("CREATE TABLE draws");
  expect(v13Schema).not.toContain("claim_xp");
  expect(v13Schema).not.toContain("claimed_at");
  expect(v13Schema).not.toContain("sort_order");
  expect(v13Schema).not.toContain("achievement_customizations");

  const legacy = new Database(path.join(process.env.DATA_DIR!, "app.db"));
  legacy.exec(v13Schema);

  // A pre-#156 unlock: the achievements row carries unlocked_at only.
  legacy
    .prepare("INSERT INTO achievements (key, unlocked_at) VALUES ('first_completion', ?)")
    .run("2026-01-01T00:00:00.000Z");
  seededTaskId = Number(
    legacy
      .prepare("INSERT INTO tasks (title, category_id, created_at) VALUES (?, 1, ?)")
      .run("pre-v14 task", "2026-01-02T00:00:00.000Z").lastInsertRowid,
  );

  legacy.pragma("user_version = 13");
  legacy.close();

  await freshApp(); // importing db.ts runs migrate() on the v13 file
});

describe("migration v13 → v14 (#156, ADR-42)", () => {
  it("runs the chain to the current version (17: v14 draws/claim, v15 sort_order, v16 customizations, v17 xp_ledger)", async () => {
    const db = await testDb();
    expect(db.pragma("user_version", { simple: true })).toBe(17);
  });

  it("creates the draws log with the append-only shape", async () => {
    const db = await testDb();
    const cols = db.prepare("PRAGMA table_info(draws)").all() as {
      name: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    expect(cols.map((c) => c.name).sort()).toEqual(["drawn_at", "id", "task_id", "was_warmup"].sort());
    // was_warmup NOT NULL default 0; drawn_at NOT NULL; task_id nullable.
    expect(cols.find((c) => c.name === "was_warmup")).toMatchObject({ notnull: 1, dflt_value: "0" });
    expect(cols.find((c) => c.name === "drawn_at")!.notnull).toBe(1);
    expect(cols.find((c) => c.name === "task_id")!.notnull).toBe(0);
  });

  it("wires task_id ON DELETE SET NULL, never CASCADE — a draw outlives its task", async () => {
    const db = await testDb();
    db.prepare("INSERT INTO draws (task_id, drawn_at, was_warmup) VALUES (?, ?, 0)").run(
      seededTaskId,
      "2026-01-03T00:00:00.000Z",
    );
    // Deleting the task must NULL the reference, not delete the draw row.
    db.prepare("DELETE FROM tasks WHERE id = ?").run(seededTaskId);
    const rows = db
      .prepare("SELECT task_id AS taskId, was_warmup AS wasWarmup FROM draws")
      .all() as { taskId: number | null; wasWarmup: number }[];
    expect(rows).toEqual([{ taskId: null, wasWarmup: 0 }]);
    db.prepare("DELETE FROM draws").run();
  });

  it("backfills the claim columns to NULL — the seeded unlock is unclaimed, launch-payday ready", async () => {
    const db = await testDb();
    const cols = db.prepare("PRAGMA table_info(achievements)").all() as {
      name: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    for (const name of ["claimed_at", "claim_xp"]) {
      const col = cols.find((c) => c.name === name);
      expect(col, name).toBeTruthy();
      expect(col!.notnull, name).toBe(0);
      expect(col!.dflt_value, name).toBeNull();
    }
    const row = db
      .prepare(
        "SELECT unlocked_at AS unlockedAt, claimed_at AS claimedAt, claim_xp AS claimXp FROM achievements WHERE key = 'first_completion'",
      )
      .get() as { unlockedAt: string; claimedAt: string | null; claimXp: number | null };
    expect(row).toEqual({
      unlockedAt: "2026-01-01T00:00:00.000Z",
      claimedAt: null,
      claimXp: null,
    });
  });
});
