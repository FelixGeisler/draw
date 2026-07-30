import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import type Database from "better-sqlite3";
import { freshApp, testDb } from "../helpers.js";
import {
  CHALLENGE_POOL,
  CHALLENGE_XP,
  challengeForDay,
  challengeState,
  payChallengeIfDue,
} from "../../src/services/challengeService.js";
import { localDate } from "../../src/services/localDay.js";

// The dealer's daily challenge (#231, ADR-63): deterministic per local day,
// progress derived from today's rows, payout an exactly-once ledger row.
// The day's ACTUAL challenge is whatever the date hashes to, so these tests
// mostly drive the service against crafted rows rather than betting on which
// objective today happens to name.

let app: express.Express;
let db: Database.Database;
let taskId: number;

beforeAll(async () => {
  app = await freshApp();
  db = await testDb();
  taskId = Number(
    db
      .prepare("INSERT INTO tasks (title, category_id, impact, created_at) VALUES (?, 1, 3, ?)")
      .run("challenge seed", new Date().toISOString()).lastInsertRowid,
  );
});

beforeEach(() => {
  db.prepare("DELETE FROM xp_ledger").run();
  db.prepare("DELETE FROM completions").run();
  db.prepare("DELETE FROM time_entries").run();
});

function completeAtNoon(count: number, opts: { drawn?: boolean } = {}) {
  // 11:00, not 12:00: the before_noon window is [start, noon) EXCLUSIVE, and
  // a seed at exactly noon would sit outside it on the day that objective
  // comes up — which is precisely how this test first failed.
  const noon = new Date();
  noon.setHours(11, 0, 0, 0);
  const insert = db.prepare(
    "INSERT INTO completions (task_id, completed_at, was_drawn, was_warmup, xp_awarded) VALUES (?, ?, ?, 0, 1)",
  );
  for (let i = 0; i < count; i++) insert.run(taskId, noon.toISOString(), opts.drawn ? 1 : 0);
}

describe("challengeForDay", () => {
  it("is deterministic per day and varies across days", () => {
    expect(challengeForDay("2026-07-30")).toBe(challengeForDay("2026-07-30"));
    const keys = new Set(
      ["2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02", "2026-08-03"].map(
        (d) => challengeForDay(d).key,
      ),
    );
    // Seven consecutive days land on more than one objective — the pool is
    // actually rotating, not stuck on one entry.
    expect(keys.size).toBeGreaterThan(1);
  });

  it("every pool entry is reachable by some day", () => {
    const seen = new Set<string>();
    for (let i = 1; i <= 60 && seen.size < CHALLENGE_POOL.length; i++) {
      seen.add(challengeForDay(`2026-07-${String((i % 28) + 1).padStart(2, "0")}x${i}`).key);
    }
    expect(seen.size).toBe(CHALLENGE_POOL.length);
  });
});

describe("GET /api/challenge", () => {
  it("ships today's derived state and never pays", async () => {
    const res = await request(app).get("/api/challenge").expect(200);
    expect(res.body).toMatchObject({
      day: localDate(new Date()),
      xp: CHALLENGE_XP,
      paid: false,
    });
    expect(res.body.progress).toBeLessThanOrEqual(res.body.target);
    expect(db.prepare("SELECT COUNT(*) AS n FROM xp_ledger").get()).toEqual({ n: 0 });
  });
});

describe("payChallengeIfDue", () => {
  it("pays exactly once when the objective is met, and never again that day", () => {
    // Satisfy EVERY pool objective at once: 3 drawn completions at noon cover
    // complete_3, drawn_2, before_noon; a 40-minute closed entry covers
    // track_30; two subtask completions cover steps_2 — so this test holds no
    // matter which challenge today's date hashes to.
    completeAtNoon(3, { drawn: true });
    const noon = new Date();
    noon.setHours(11, 0, 0, 0);
    const end = new Date(noon.getTime() + 40 * 60_000);
    db.prepare("INSERT INTO time_entries (task_id, started_at, ended_at) VALUES (?, ?, ?)").run(
      taskId,
      noon.toISOString(),
      end.toISOString(),
    );
    const stepId = Number(
      db
        .prepare(
          "INSERT INTO tasks (title, category_id, parent_id, impact, created_at) VALUES (?, 1, ?, 3, ?)",
        )
        .run("challenge step", taskId, new Date().toISOString()).lastInsertRowid,
    );
    const noonIso = (() => {
      const d = new Date();
      d.setHours(11, 0, 0, 0);
      return d.toISOString();
    })();
    for (let i = 0; i < 2; i++) {
      db.prepare(
        "INSERT INTO completions (task_id, completed_at, was_drawn, was_warmup, xp_awarded) VALUES (?, ?, 0, 0, 1)",
      ).run(stepId, noonIso);
    }

    expect(challengeState().completed).toBe(true);
    expect(payChallengeIfDue()).toBe(true); // this call lands the payout
    expect(payChallengeIfDue()).toBe(false); // idempotent forever after
    const rows = db
      .prepare("SELECT amount, ref FROM xp_ledger WHERE reason = 'challenge'")
      .all() as { amount: number; ref: string }[];
    expect(rows).toEqual([{ amount: CHALLENGE_XP, ref: localDate(new Date()) }]);
    expect(challengeState().paid).toBe(true);
  });

  it("pays nothing while the objective is unmet", () => {
    expect(payChallengeIfDue()).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM xp_ledger").get()).toEqual({ n: 0 });
  });
});

describe("the payout rides the completion transaction", () => {
  it("a real PATCH completion that satisfies today's objective banks the XP in the same request", async () => {
    // Pre-load everything EXCEPT the last completion, again covering every
    // objective, then finish through the real route: whichever challenge
    // today names, this completion either satisfies it or it was already
    // satisfied — either way the payout must exist afterwards.
    completeAtNoon(2, { drawn: true });
    const start = new Date();
    start.setHours(11, 0, 0, 0);
    db.prepare("INSERT INTO time_entries (task_id, started_at, ended_at) VALUES (?, ?, ?)").run(
      taskId,
      start.toISOString(),
      new Date(start.getTime() + 40 * 60_000).toISOString(),
    );
    const stepId = Number(
      db
        .prepare(
          "INSERT INTO tasks (title, category_id, parent_id, impact, created_at) VALUES (?, 1, ?, 3, ?)",
        )
        .run("challenge live step", taskId, new Date().toISOString()).lastInsertRowid,
    );
    db.prepare(
      "INSERT INTO completions (task_id, completed_at, was_drawn, was_warmup, xp_awarded) VALUES (?, ?, 0, 0, 1)",
    ).run(stepId, new Date().toISOString());

    const fresh = Number(
      db
        .prepare("INSERT INTO tasks (title, category_id, parent_id, impact, created_at) VALUES (?, 1, ?, 3, ?)")
        .run("finishing step", taskId, new Date().toISOString()).lastInsertRowid,
    );
    // Guard: noon may have passed in this test's wall-clock run — before_noon
    // needs a completion before 12:00, which the noon seeds above provided
    // only if it IS today's challenge and now < noon. Cover it directly.
    if (challengeForDay(localDate(new Date())).key === "before_noon") {
      const morning = new Date();
      morning.setHours(9, 0, 0, 0);
      db.prepare(
        "INSERT INTO completions (task_id, completed_at, was_drawn, was_warmup, xp_awarded) VALUES (?, ?, 0, 0, 1)",
      ).run(taskId, morning.toISOString());
    }

    const res = await request(app).patch(`/api/tasks/${fresh}`).send({ status: "done" });
    expect(res.status).toBe(200);
    expect(challengeState().paid).toBe(true);
  });
});
