import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type express from "express";
import type Database from "better-sqlite3";
import { freshApp, testDb } from "../helpers.js";
import {
  CHALLENGE_GOLD,
  CHALLENGE_POOL,
  CHALLENGE_XP,
  challengeForDay,
  challengeState,
  payChallengeIfDue,
} from "../../src/services/challengeService.js";
import { localDate } from "../../src/services/localDay.js";
import { setFetchForTests } from "../../src/services/notifyService.js";

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
  // Roll each case back as a whole: gold_ledger is append-only, and the test
  // contract must not bypass that trigger merely to isolate cases.
  db.exec("BEGIN");
  db.prepare("DELETE FROM xp_ledger").run();
  db.prepare("DELETE FROM completions").run();
  db.prepare("DELETE FROM time_entries").run();
});

afterEach(() => {
  setFetchForTests(null);
  db.exec("ROLLBACK");
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

/** Satisfy every pool objective, independent of which one today hashes to. */
function satisfyEveryChallenge() {
  completeAtNoon(3, { drawn: true });
  const morning = new Date();
  morning.setHours(9, 0, 0, 0);
  db.prepare("INSERT INTO time_entries (task_id, started_at, ended_at) VALUES (?, ?, ?)").run(
    taskId,
    morning.toISOString(),
    new Date(morning.getTime() + 40 * 60_000).toISOString(),
  );
  const stepId = Number(
    db
      .prepare(
        "INSERT INTO tasks (title, category_id, parent_id, impact, created_at) VALUES ('matrix step', 1, ?, 3, ?)",
      )
      .run(taskId, new Date().toISOString()).lastInsertRowid,
  );
  for (let i = 0; i < 2; i++) {
    db.prepare(
      "INSERT INTO completions (task_id, completed_at, was_drawn, was_warmup, xp_awarded) VALUES (?, ?, 0, 0, 1)",
    ).run(stepId, morning.toISOString());
  }
  expect(challengeState().completed).toBe(true);
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
      gold: CHALLENGE_GOLD,
      paid: false,
      goldPaid: false,
      goldAwarded: 0,
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
    const xpRows = db
      .prepare("SELECT amount, ref FROM xp_ledger WHERE reason = 'challenge'")
      .all() as { amount: number; ref: string }[];
    const goldRows = db
      .prepare("SELECT amount, ref FROM gold_ledger WHERE reason = 'challenge'")
      .all() as { amount: number; ref: string }[];
    const ref = localDate(new Date());
    expect(xpRows).toEqual([{ amount: CHALLENGE_XP, ref }]);
    expect(goldRows).toEqual([{ amount: CHALLENGE_GOLD, ref }]);
    expect(challengeState()).toMatchObject({
      paid: true,
      goldPaid: true,
      goldAwarded: CHALLENGE_GOLD,
    });
  });

  it("pays nothing while the objective is unmet", () => {
    expect(payChallengeIfDue()).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM xp_ledger").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM gold_ledger").get()).toEqual({ n: 0 });
  });

  it("preserves the four legacy/anomaly states without repair", () => {
    const day = localDate(new Date());
    satisfyEveryChallenge();

    // XP-only is an immutable legacy paid day: no Gold backfill.
    db.prepare(
      "INSERT INTO xp_ledger (amount, reason, ref, created_at) VALUES (50, 'challenge', ?, ?)",
    ).run(day, new Date().toISOString());
    expect(payChallengeIfDue()).toBe(false);
    expect(challengeState()).toMatchObject({ paid: true, goldPaid: false, goldAwarded: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM gold_ledger").get()).toEqual({ n: 0 });

    // Both present is already paid and remains untouched, including actual Gold.
    db.prepare(
      "INSERT INTO gold_ledger (amount, reason, ref, created_at) VALUES (17, 'challenge', ?, ?)",
    ).run(day, new Date().toISOString());
    expect(payChallengeIfDue()).toBe(false);
    expect(challengeState()).toMatchObject({ paid: true, goldPaid: true, goldAwarded: 17 });
  });

  it("fails a Gold-only payout attempt and repairs nothing", () => {
    const day = localDate(new Date());
    satisfyEveryChallenge();
    db.prepare(
      "INSERT INTO gold_ledger (amount, reason, ref, created_at) VALUES (20, 'challenge', ?, ?)",
    ).run(day, new Date().toISOString());

    expect(() => payChallengeIfDue()).toThrow(/Gold exists without XP/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM xp_ledger").get()).toEqual({ n: 0 });
    expect(challengeState()).toMatchObject({ paid: false, goldPaid: true, goldAwarded: 20 });
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
    expect(challengeState()).toMatchObject({ paid: true, goldPaid: true, goldAwarded: 20 });
  });

  for (const owner of ["xp", "gold"] as const) {
    it(`rolls back the completion and both payouts when the ${owner} challenge row fails`, async () => {
      satisfyEveryChallenge();
      const fresh = Number(
        db
          .prepare(
            "INSERT INTO tasks (title, category_id, impact, created_at) VALUES (?, 1, 3, ?)",
          )
          .run(`${owner} failure completion`, new Date().toISOString()).lastInsertRowid,
      );
      db.exec(`CREATE TRIGGER test_${owner}_challenge_failure
        BEFORE INSERT ON ${owner}_ledger WHEN NEW.reason = 'challenge' BEGIN
          SELECT RAISE(ABORT, 'forced ${owner} challenge failure');
        END`);
      const send = vi.fn().mockResolvedValue({ ok: true });
      setFetchForTests(send);
      await request(app).put("/api/notify/url").send({ url: "https://ntfy.sh/challenge-test" });

      await request(app).patch(`/api/tasks/${fresh}`).send({ status: "done" }).expect(500);
      expect(db.prepare("SELECT status FROM tasks WHERE id = ?").get(fresh)).toEqual({
        status: "open",
      });
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM completions WHERE task_id = ?").get(fresh),
      ).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM xp_ledger").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM gold_ledger").get()).toEqual({ n: 0 });
      await new Promise((resolve) => setImmediate(resolve));
      expect(send).not.toHaveBeenCalled();
    });
  }
});

describe("the payout rides the timer-stop transaction", () => {
  it("closes the timer and commits both same-ref rows together", async () => {
    satisfyEveryChallenge();
    const started = new Date(Date.now() - 40 * 60_000).toISOString();
    db.prepare("INSERT INTO time_entries (task_id, started_at) VALUES (?, ?)").run(taskId, started);

    const res = await request(app).post("/api/timer/stop").expect(200);
    expect(res.body.challengeCompleted).toBe(true);
    expect(challengeState()).toMatchObject({ paid: true, goldPaid: true, goldAwarded: 20 });
    expect(db.prepare("SELECT ended_at AS endedAt FROM time_entries WHERE started_at = ?").get(started)).toEqual({
      endedAt: expect.any(String),
    });
  });

  it("leaves the timer running when the challenge Gold owner fails", async () => {
    satisfyEveryChallenge();
    const started = new Date(Date.now() - 40 * 60_000).toISOString();
    db.prepare("INSERT INTO time_entries (task_id, started_at) VALUES (?, ?)").run(taskId, started);
    db.exec(`CREATE TRIGGER test_timer_gold_failure
      BEFORE INSERT ON gold_ledger WHEN NEW.reason = 'challenge' BEGIN
        SELECT RAISE(ABORT, 'forced timer Gold failure');
      END`);

    await request(app).post("/api/timer/stop").expect(500);
    expect(db.prepare("SELECT ended_at AS endedAt FROM time_entries WHERE started_at = ?").get(started)).toEqual({
      endedAt: null,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM xp_ledger").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM gold_ledger").get()).toEqual({ n: 0 });
  });
});
