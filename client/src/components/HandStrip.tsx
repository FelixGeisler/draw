import { useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useCardArtBatch } from "../hooks/useAi";
import { useDealHand, useHand, type DealResponse } from "../hooks/useHand";
import { useCategories, useSettings } from "../hooks/useTasks";
import { artByTask, svgDataUri } from "../lib/cardVisuals";
import { handCardState, handEffortMinutes } from "../lib/hand";
import { EmptyPoolReason } from "./EmptyPoolReason";
import { CategoryPill, ImpactStars } from "./TaskBadges";
import "./HandStrip.css";

/**
 * The daily hand (#59, ADR-34) — "deal me a day" at the top of the Draw page:
 * the morning answer to "what does my day look like?", played one card at a
 * time. Dealt once per local day; it only ever shrinks.
 *
 * There is deliberately NO redeal control (ADR-34): a hand you can re-deal is
 * a five-card re-roll, which is the card-fishing #88 removed from the single
 * draw. A card you do not want leaves the way any drawn card leaves — resolve
 * it ("Not now", edit, delete, or just do it) — and the freestyle draw below
 * the strip is always available.
 *
 * Card faces follow the #123/ADR-33 language, in miniature: full-bleed cached
 * art under a legibility scrim, subtle chips, and the holo shimmer on a 5★
 * goal-linked card. (No card-frame chrome — ADR-31's frame is gone.)
 */
export function HandStrip({
  playable,
  currentTaskId,
  onPlay,
}: {
  /** False while a card is on the table: playing another would be a re-roll,
   *  and the server answers 409 (#88). The strip says so instead of lying. */
  playable: boolean;
  /** The current draw's id — that card renders as "in play", not playable. */
  currentTaskId: number | null;
  onPlay: (taskId: number) => void;
}) {
  const hand = useHand();
  const deal = useDealHand();
  const categories = useCategories();
  const [dealt, setDealt] = useState<DealResponse | null>(null);

  // Face art (#114): ONE cache-only batch read for the whole strip — never
  // the per-task GET, which generates on a miss. Cards without cached art keep
  // the category-tinted gradient face, silently (degraded mode included).
  const batchArt = useCardArtBatch((hand.data?.tasks ?? []).map((t) => t.id));
  const art = artByTask(batchArt.data?.arts);

  async function doDeal() {
    setDealt(await deal.mutateAsync());
  }

  // Query not settled yet: render nothing rather than guess. Showing "Deal me
  // a day" here would offer an action that is already spent on most mornings
  // — and a click landing before the hand arrives would just take the deal
  // route's 409.
  if (hand.data === undefined) return null;

  // No hand today: the ritual's entry point. The budget input sits right here
  // rather than in Settings — it is the one number this button reads, and
  // duplicating it into a settings row would be a second control for the same
  // thing (and hide it from the moment it matters).
  if (hand.data === null) {
    return (
      <div className="hand-strip">
        <div className="hand-cta">
          <button className="primary" onClick={doDeal} disabled={deal.isPending}>
            🗓 Deal me a day
          </button>
          <BudgetInput />
        </div>
        {dealt && !dealt.hand && (
          <div className="panel hand-empty">
            {dealt.reason === "budget_too_small" ? (
              <BudgetTooSmall />
            ) : (
              <EmptyPoolReason reason={dealt.reason} />
            )}
          </div>
        )}
      </div>
    );
  }

  const total = handEffortMinutes(hand.data.tasks);

  return (
    <div className="hand-strip">
      <h3>
        Today's hand — {hand.data.tasks.length} card{hand.data.tasks.length === 1 ? "" : "s"} ·{" "}
        {total} / {hand.data.budgetMinutes} min
      </h3>
      {hand.data.tasks.length === 0 ? (
        // Every card resolved (or pruned): the plan is spent. No new hand
        // today — that is the commitment — but the deck below is untouched.
        <p className="hand-note">
          Today's hand is played out. A fresh one comes with tomorrow — the deck below is still
          there whenever you want one more.
        </p>
      ) : (
        <div className="hand-cards">
          {hand.data.tasks.map((task) => {
            const category = categories.data?.find((c) => c.id === task.categoryId);
            const state = handCardState(task.id, currentTaskId, playable);
            const inPlay = state === "in-play";
            // Same holo rule as the standing card (#123): a gambled 5★
            // goal-linked card shimmers. A dealt card WAS gambled — weighted
            // sampling out of the same pool — unlike the warm-up's handout,
            // and completing it mints a holo trophy, so display and reward
            // agree here too.
            const holo = task.impact === 5 && task.goalId != null;
            const cardArt = art.get(task.id);
            return (
              <button
                key={task.id}
                className={`hand-card${inPlay ? " in-play" : ""}${holo ? " holo" : ""}`}
                style={{ "--cat-color": category?.color } as CSSProperties}
                disabled={state !== "playable"}
                title={
                  state === "in-play"
                    ? "This card is on the table"
                    : state === "playable"
                      ? `Play "${task.title}"`
                      : "Finish the card on the table first — playing another would be a re-roll"
                }
                aria-label={[
                  inPlay ? `${task.title}, in play` : `Play ${task.title}`,
                  category?.name,
                  task.effortMinutes != null ? `${task.effortMinutes} minutes` : null,
                ]
                  .filter(Boolean)
                  .join(", ")}
                onClick={() => onPlay(task.id)}
              >
                {cardArt && (
                  <>
                    <img className="hand-art" alt="" aria-hidden="true" src={svgDataUri(cardArt)} />
                    <div className="hand-art-scrim" />
                  </>
                )}
                <div className="hand-card-title">{task.title}</div>
                <div className="hand-card-foot">
                  {category && <CategoryPill category={category} />}
                  <div className="hand-card-chips">
                    {task.effortMinutes != null && (
                      <span className="chip">{task.effortMinutes} min</span>
                    )}
                    {task.goalId != null && <ImpactStars value={task.impact} />}
                  </div>
                </div>
                <div className="hand-card-state">{inPlay ? "▶ in play" : "play"}</div>
                {holo && <div className="hand-holo" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The empty-deal reason the pool cannot express: the deck has cards, the
 *  budget just cannot hold the smallest one. One input away — say so. */
function BudgetTooSmall() {
  return (
    <p>
      No card fits today's budget. Give the day a few more minutes, or{" "}
      <Link to="/capture" style={{ color: "var(--accent)" }}>
        break something down
      </Link>{" "}
      into smaller cards.
    </p>
  );
}

/**
 * The day's effort budget (`daily_hand_budget_minutes`) — how many minutes of
 * cards a deal may hand out. Saved on blur, like the Settings page's inputs.
 */
function BudgetInput() {
  const settings = useSettings();
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (v: number) => api.patch("/api/settings", { daily_hand_budget_minutes: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });
  const value = settings.data?.daily_hand_budget_minutes;
  if (value === undefined) return null;
  return (
    <label className="hand-budget">
      <input
        type="number"
        min={1}
        className="hand-budget-input"
        defaultValue={value}
        onBlur={(e) => {
          const v = Number(e.target.value);
          if (Number.isInteger(v) && v > 0 && String(v) !== value) save.mutate(v);
        }}
      />
      <span>minutes for today</span>
    </label>
  );
}
