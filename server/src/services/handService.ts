import {
  CURRENT_DRAW_SETTING,
  DAILY_HAND_SETTING,
  db,
  deleteSetting,
  getSetting,
  getSettingString,
  setSetting,
  WARMUP_DRAW_SETTING,
} from "../db.js";
import {
  dealtTaskRow,
  emptyPoolReason,
  isRestorable,
  poolWeights,
  queryCandidates,
  taskWithDeckState,
  toTaskPayload,
  type PoolCandidate,
  type RestorableTask,
} from "./drawService.js";
import { localDate } from "./localDay.js";

// ---------------------------------------------------------------------------
// The daily hand (#59, ADR-34) — "deal me a day": a small, effort-budgeted
// hand of cards dealt once per local day as today's plan, played one at a
// time. The hand is session state in one settings row (ADR-13's pattern), not
// a table: it is a pointer LIST into tasks, derived-by-validation on every
// read, and it dies at local midnight.
//
// The hand is a COMMITMENT (#88), which is the whole design:
//   - it is dealt ONCE per local day and only ever SHRINKS;
//   - there is NO redeal — see ADR-34; a card leaves the hand only by being
//     resolved (completed, snoozed/blocked, edited out of the deck, deleted),
//     which is exactly the single draw's sanctioned escape;
//   - playing a card while another card is revealed is impossible (the route
//     answers 409, like the warm-up deal), so the hand can never re-roll the
//     standing card either.

/** At most five cards — the strip is today's plan, not the backlog (#30). */
export const HAND_MAX_CARDS = 5;

export interface Hand {
  /** Server-LOCAL day (the streak convention) this hand was dealt for. */
  date: string;
  budgetMinutes: number;
  tasks: Record<string, unknown>[];
}

export interface DealResult {
  hand: Hand | null;
  reason?: "no_ready_tasks" | "all_too_big" | "all_outside_window" | "budget_too_small";
}

interface StoredHand {
  date: string;
  taskIds: number[];
  /**
   * The budget this hand was DEALT against — stored, not re-read from the live
   * setting, because it is a historical fact of the deal, not derived state
   * (ADR-34 (d)). A later PATCH of `daily_hand_budget_minutes` must not rewrite
   * a standing hand's header.
   */
  budgetMinutes: number;
}

function budgetMinutes(): number {
  return getSetting("daily_hand_budget_minutes", 90);
}

/**
 * The persisted hand, or null when there is none FOR TODAY. A row from an
 * earlier local day is not a hand: the ritual resets at local midnight and
 * unplayed cards return to the deck with no carryover and no penalty. The
 * stale row is left to be overwritten by the next deal rather than deleted on
 * read — a GET must not need a write to answer "no hand today".
 */
function storedHand(now: Date): StoredHand | null {
  const raw = getSettingString(DAILY_HAND_SETTING);
  if (raw == null) return null;
  let parsed: StoredHand;
  try {
    parsed = JSON.parse(raw) as StoredHand;
  } catch {
    return null; // hand-edited DB — treat as absent rather than breaking the page
  }
  if (parsed?.date !== localDate(now) || !Array.isArray(parsed.taskIds)) return null;
  // Legacy row from before the budget was stored with the deal: fall back to
  // the live setting so an in-flight hand dealt under the old code still reads.
  if (typeof parsed.budgetMinutes !== "number") parsed.budgetMinutes = budgetMinutes();
  return parsed;
}

function writeHand(hand: StoredHand) {
  setSetting(DAILY_HAND_SETTING, JSON.stringify(hand));
}

/**
 * Today's hand with every member re-validated and permanently pruned — ADR-13's
 * lazy validation, widened from one pointer to a list. A card that went stale
 * SIDEWAYS (completed elsewhere, edited too big or unestimated, broken down
 * into a container, its window closed) is dropped here and the shortened list
 * is persisted, so the prune is not re-derived on every read and a card the
 * user saw leave can never come back.
 *
 * The eager removals live elsewhere on purpose (removeFromHand /
 * pruneDanglingHand): a snooze wears off and a freed task id can be re-bound
 * without any GET in between, so those two cannot wait for this.
 */
export function currentHand(): Hand | null {
  const now = new Date();
  const stored = storedHand(now);
  if (!stored) return null;

  const maxEffort = getSetting("max_draw_effort", 30);
  const tasks: Record<string, unknown>[] = [];
  for (const id of stored.taskIds) {
    const row = taskWithDeckState(id);
    if (!row) continue; // deleted; pruneDanglingHand normally got here first
    const payload = toTaskPayload(row); // parses windowDays for isRestorable
    if (isRestorable(payload as unknown as RestorableTask, maxEffort, now)) tasks.push(payload);
  }

  const survivingIds = tasks.map((t) => t.id as number);
  if (survivingIds.length !== stored.taskIds.length) {
    writeHand({ date: stored.date, taskIds: survivingIds, budgetMinutes: stored.budgetMinutes });
  }
  return { date: stored.date, budgetMinutes: stored.budgetMinutes, tasks };
}

/**
 * Weighted sampling WITHOUT replacement under an effort budget — the deal
 * algorithm, kept pure (candidates in, candidates out) so its invariants are
 * unit-testable without a database.
 *
 * Each round: keep only the candidates that still FIT the remaining budget,
 * weight them with the shared `poolWeights` (impact²/effort × urgency ×
 * staleness × sibling damping — ADR-25), pick one, spend its effort. Stop at
 * HAND_MAX_CARDS or when nothing fits. Random rather than a deterministic
 * top-N by weight: a top-N hand would be the same five cards every morning
 * until they are done, which is a to-do list, not a deal.
 *
 * The weights are recomputed each round over the CURRENTLY SAMPLABLE set, and
 * that is the faithful reading of ADR-25's damping rule ("k counts siblings
 * PRESENT IN THE POOL"): siblings that cannot fit the remaining budget cannot
 * flood this deal, so — exactly like snoozed, held-back or out-of-window
 * siblings — they must not dampen the one card that represents them.
 */
export function dealFromPool<T extends PoolCandidate>(
  candidates: T[],
  now: Date,
  cooldownMinutes: number,
  budget: number,
): T[] {
  const remaining = [...candidates];
  const picked: T[] = [];
  let left = budget;

  while (picked.length < HAND_MAX_CARDS) {
    const fits = remaining.filter((c) => c.effortMinutes <= left);
    if (fits.length === 0) break;

    const weights = poolWeights(fits, now, cooldownMinutes);
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    let index = fits.length - 1;
    for (let i = 0; i < fits.length; i++) {
      r -= weights[i];
      if (r <= 0) {
        index = i;
        break;
      }
    }

    const chosen = fits[index];
    picked.push(chosen);
    left -= chosen.effortMinutes;
    remaining.splice(remaining.indexOf(chosen), 1); // without replacement
  }
  return picked;
}

/**
 * Deal today's hand. Eligibility is EXACTLY the draw's candidate pool
 * (queryCandidates, unfiltered — the freestyle draw keeps its category/goal
 * chips, the day's plan is the whole deck).
 *
 * Deliberately NO side effects on the cards: dealing does not stamp
 * `last_drawn_at`. A dealt card is not a drawn card — it has not been played
 * yet — so it must not eat the cooldown dampener, and a card that is dealt
 * but never played must not carry a phantom "recently drawn" bonus into
 * completion (routes/tasks.ts derives the drawn bonus from `wasRecentlyDrawn`
 * too). Only playing stamps it.
 *
 * Precondition (enforced by the route): no hand exists for today — one hand
 * per local day, and no redeal (ADR-34).
 */
export function dealHand(): DealResult {
  const now = new Date();
  const maxEffort = getSetting("max_draw_effort", 30);
  const cooldown = getSetting("draw_cooldown_minutes", 60);
  const budget = budgetMinutes();

  const { candidates, windowExcluded } = queryCandidates({}, maxEffort, now);
  if (candidates.length === 0) {
    return { hand: null, reason: emptyPoolReason({}, windowExcluded, now) };
  }

  const picked = dealFromPool(candidates, now, cooldown, budget);
  if (picked.length === 0) {
    // Eligible cards exist, but not one of them fits the budget — an honest
    // reason of its own: neither the deck nor the estimates are the problem,
    // the number the user chose is, and it is one input away.
    return { hand: null, reason: "budget_too_small" };
  }

  const taskIds = picked.map((c) => c.id);
  writeHand({ date: localDate(now), taskIds, budgetMinutes: budget });
  return {
    hand: {
      date: localDate(now),
      budgetMinutes: budget,
      tasks: taskIds.map((id) => toTaskPayload(dealtTaskRow(id))),
    },
  };
}

export type PlayError = "no_hand" | "not_in_hand";

/**
 * Play a card: it BECOMES the current draw, with exactly the side effects of
 * a draw (ADR-13 pointer, `last_drawn_at` stamp) — so reload-restore, the
 * drawn-completion bonus and the snooze/edit/delete card actions all work on
 * it unchanged, with no second code path.
 *
 * The card is re-validated first (the same isRestorable as the GET) and
 * pruned if stale: playing must never make a card that is no longer in the
 * deck the current draw.
 *
 * Precondition (enforced by the route, mirroring the warm-up): no valid
 * current draw exists. Playing is not a re-roll (#88).
 */
export function playHandCard(taskId: number): { task: Record<string, unknown> } | PlayError {
  const now = new Date();
  const stored = storedHand(now);
  if (!stored) return "no_hand";
  if (!stored.taskIds.includes(taskId)) return "not_in_hand";

  const row = taskWithDeckState(taskId);
  const payload = row && toTaskPayload(row);
  const maxEffort = getSetting("max_draw_effort", 30);
  if (!payload || !isRestorable(payload as unknown as RestorableTask, maxEffort, now)) {
    // Stale member: prune it permanently, exactly like the GET would, and
    // report it as gone rather than dealing a card that left the deck.
    writeHand({
      date: stored.date,
      taskIds: stored.taskIds.filter((id) => id !== taskId),
      budgetMinutes: stored.budgetMinutes,
    });
    return "not_in_hand";
  }

  db.prepare("UPDATE tasks SET last_drawn_at = ? WHERE id = ?").run(now.toISOString(), taskId);
  setSetting(CURRENT_DRAW_SETTING, String(taskId));
  // A played hand card is a gambled card, not a warm-up deal: it keeps the
  // ×1.5 drawn bonus and the 5★ holo, and any leftover marker dies with the
  // pointer it described — the same line drawTask() draws.
  deleteSetting(WARMUP_DRAW_SETTING);

  return { task: toTaskPayload(dealtTaskRow(taskId)) };
}

/**
 * Remove one card from today's hand, eagerly. Called where a card leaves the
 * deck SIDEWAYS in a way the lazy validation above cannot be trusted to catch
 * in time:
 *   - completeTask() — required, because a recurring task stays open (ADR-6)
 *     and would sail straight through isRestorable;
 *   - the snooze/block/reparent PATCH — a snooze wears off (and a block can be
 *     woken) with no GET in between, and the once-again valid card would
 *     resurrect in the hand the user explicitly sent it away from (ADR-17).
 *
 * Silent no-op when there is no hand today or the task is not in it.
 */
export function removeFromHand(taskId: number) {
  const stored = storedHand(new Date());
  if (!stored || !stored.taskIds.includes(taskId)) return;
  writeHand({
    date: stored.date,
    taskIds: stored.taskIds.filter((id) => id !== taskId),
    budgetMinutes: stored.budgetMinutes,
  });
}

/**
 * Drop hand members whose task row no longer exists — the list-shaped twin of
 * clearDanglingDraw(), and eager for the same reason: `tasks.id` has no
 * AUTOINCREMENT, so SQLite can re-bind a freed id to the next captured task
 * before any validation runs, and a never-dealt newcomer would show up in the
 * hand — and be playable for the drawn bonus — under the old id. Cleared on
 * row absence, not id match, so a cascade-deleted subtask is covered too.
 */
export function pruneDanglingHand() {
  const stored = storedHand(new Date());
  if (!stored) return;
  const exists = db.prepare("SELECT 1 FROM tasks WHERE id = ?");
  const surviving = stored.taskIds.filter((id) => exists.get(id));
  if (surviving.length !== stored.taskIds.length) {
    writeHand({ date: stored.date, taskIds: surviving, budgetMinutes: stored.budgetMinutes });
  }
}
