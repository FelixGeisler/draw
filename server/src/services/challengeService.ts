import { db } from "../db.js";
import { localDate, localDayBounds } from "./localDay.js";

/**
 * The dealer's daily challenge (#231, ADR-63). One objective per LOCAL day,
 * picked deterministically from a pool by hashing the day string — derived,
 * no storage, no config: the same day names the same challenge on every
 * device and every restart. Progress is derived from today's rows
 * (localDayBounds, the #219 rules), and the payout is an xp_ledger row with
 * UNIQUE(reason='challenge', ref=<day>) — idempotent by construction, at most
 * one payout per calendar day no matter how many events re-evaluate it.
 */

export const CHALLENGE_XP = 50;

export interface ChallengeDef {
  key: string;
  label: string;
  target: number;
}

/**
 * The pool. Every entry's progress is derivable from the day's rows alone —
 * nothing here needs state that is not already logged. Order is part of the
 * hash contract: APPEND new challenges, never reorder, or every historical
 * day would retroactively name a different challenge.
 */
export const CHALLENGE_POOL: ChallengeDef[] = [
  { key: "complete_3", label: "Complete 3 tasks", target: 3 },
  { key: "drawn_2", label: "Complete 2 drawn cards", target: 2 },
  { key: "steps_2", label: "Complete 2 steps of a breakdown", target: 2 },
  { key: "before_noon", label: "Finish a task before noon", target: 1 },
  { key: "track_30", label: "Track 30 focused minutes", target: 30 },
];

/** Deterministic day-string hash — stable across restarts and platforms. */
export function challengeForDay(day: string): ChallengeDef {
  let hash = 0;
  for (const ch of day) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return CHALLENGE_POOL[hash % CHALLENGE_POOL.length];
}

function progressOf(def: ChallengeDef, day: string): number {
  const { startIso, endIso } = localDayBounds(day);
  switch (def.key) {
    case "complete_3":
      return (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM completions WHERE completed_at >= ? AND completed_at < ?",
          )
          .get(startIso, endIso) as { n: number }
      ).n;
    case "drawn_2":
      // The gambled sense (ADR-30) — the same predicate as the drawn chain.
      return (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM completions WHERE was_drawn = 1 AND was_warmup = 0 AND completed_at >= ? AND completed_at < ?",
          )
          .get(startIso, endIso) as { n: number }
      ).n;
    case "steps_2":
      return (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM completions c JOIN tasks t ON t.id = c.task_id
             WHERE t.parent_id IS NOT NULL AND c.completed_at >= ? AND c.completed_at < ?`,
          )
          .get(startIso, endIso) as { n: number }
      ).n;
    case "before_noon": {
      // Noon on the LOCAL clock: the day's start plus 12 wall hours is wrong
      // across DST, so noon is derived the same way the bounds are.
      const noonIso = new Date(`${day}T12:00:00`).toISOString();
      return (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM completions WHERE completed_at >= ? AND completed_at < ?",
          )
          .get(startIso, noonIso) as { n: number }
      ).n;
    }
    case "track_30": {
      // Whole minutes over CLOSED entries STARTED today — the stats
      // convention; a running entry pays when it stops.
      const row = db
        .prepare(
          `SELECT COALESCE(SUM((julianday(ended_at) - julianday(started_at)) * 1440.0), 0) AS minutes
           FROM time_entries WHERE ended_at IS NOT NULL AND started_at >= ? AND started_at < ?`,
        )
        .get(startIso, endIso) as { minutes: number };
      return Math.round(row.minutes);
    }
    default:
      return 0;
  }
}

export interface ChallengeState {
  day: string;
  key: string;
  label: string;
  target: number;
  progress: number;
  completed: boolean;
  /** The +XP already landed in the ledger (exactly-once per day). */
  paid: boolean;
  xp: number;
}

export function challengeState(now: Date = new Date()): ChallengeState {
  const day = localDate(now);
  const def = challengeForDay(day);
  const progress = Math.min(progressOf(def, day), def.target);
  const paid = Boolean(
    db
      .prepare("SELECT 1 FROM xp_ledger WHERE reason = 'challenge' AND ref = ?")
      .get(day),
  );
  return {
    day,
    key: def.key,
    label: def.label,
    target: def.target,
    progress,
    completed: progress >= def.target,
    paid,
    xp: CHALLENGE_XP,
  };
}

/**
 * Pay the day's challenge if it is met and unpaid. Called from the two events
 * that can satisfy a challenge — completeTask and the timer-stop route (the
 * track challenge's satisfying event is a stop, not a completion). Both call
 * THIS one function, so the R8 concern (a new event path skipping the check)
 * has a single name to grep for. INSERT OR IGNORE + UNIQUE(reason, ref) makes
 * a double evaluation pay nothing twice.
 *
 * Returns true only when THIS call landed the payout — the caller's cue to
 * announce it.
 */
export function payChallengeIfDue(now: Date = new Date()): boolean {
  const state = challengeState(now);
  if (!state.completed || state.paid) return false;
  const r = db
    .prepare(
      "INSERT OR IGNORE INTO xp_ledger (amount, reason, ref, created_at) VALUES (?, 'challenge', ?, ?)",
    )
    .run(CHALLENGE_XP, state.day, now.toISOString());
  return r.changes > 0;
}
