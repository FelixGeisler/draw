import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import confetti from "canvas-confetti";
import { useCategories, useDeleteTask, useSettings, useUpdateTask } from "../hooks/useTasks";
import { useGoals } from "../hooks/useGoals";
import {
  useCurrentDraw,
  useDraw,
  useWarmupDraw,
  useWarmupStatus,
  type DrawResponse,
} from "../hooks/useDraw";
import { useCardArt } from "../hooks/useAi";
import { useCurrentTimer, useStartTimer, useStopTimer } from "../hooks/useTimer";
import { FocusOverlay } from "../components/FocusOverlay";
import { SnoozeMenu } from "../components/SnoozeMenu";
import { TaskBadges } from "../components/TaskBadges";
import { TaskForm } from "../components/TaskForm";
import { TrophyDeck } from "../components/TrophyDeck";
import { classifyTask } from "../lib/drawable";
import { resolveDrawView } from "../lib/focusView";
import type { NewTask } from "../api/types";
import "./DrawPage.css";

type Phase = "idle" | "shuffling" | "revealed";

export function DrawPage() {
  const categories = useCategories();
  const settings = useSettings();
  const draw = useDraw();
  const warmup = useWarmupDraw();
  const warmupStatus = useWarmupStatus();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const startTimer = useStartTimer();
  const stopTimer = useStopTimer();
  const timer = useCurrentTimer();

  const goals = useGoals();
  const [categoryId, setCategoryId] = useState<number | undefined>();
  const [goalId, setGoalId] = useState<number | undefined>();
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<DrawResponse | null>(null);
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState(false);
  const [snoozing, setSnoozing] = useState(false);
  // Escape peeked out of the focus view (issue #56). Session-local on
  // purpose: the view itself is DERIVED from timer + current draw (ADR-29),
  // so a reload while the timer runs on the drawn card re-enters focus.
  const [focusExited, setFocusExited] = useState(false);
  // Why the last completion paid extra (#57) — shown once the card is gone,
  // cleared by the next draw/deal.
  const [bonusNote, setBonusNote] = useState<string | null>(null);

  // Restore the server-persisted draw once per mount (issue #25) — a reload
  // lands straight on the revealed card, no shuffle, mirroring the TimerBar.
  // The one-shot guard keeps a late or stale response from resurrecting a
  // card after the user already drew, completed, or deleted in this session.
  const currentDraw = useCurrentDraw();
  const restoreAttempted = useRef(false);
  useEffect(() => {
    if (restoreAttempted.current || currentDraw.isFetching || currentDraw.data === undefined)
      return;
    restoreAttempted.current = true;
    if (currentDraw.data?.task && phase === "idle" && result === null) {
      // The warm-up marker rides along (#57) so the badge survives reloads.
      setResult({ task: currentDraw.data.task, warmup: currentDraw.data.warmup });
      setPhase("revealed");
    }
  }, [currentDraw.isFetching, currentDraw.data, phase, result]);

  async function reveal(mutate: () => Promise<DrawResponse>) {
    setPhase("shuffling");
    setResult(null);
    setEditing(false);
    setEdited(false);
    setSnoozing(false);
    setFocusExited(false);
    setBonusNote(null);
    const [response] = await Promise.all([
      mutate(),
      new Promise((r) => setTimeout(r, 450)), // let the shuffle play
    ]);
    setResult(response);
    setPhase(response.task ? "revealed" : "idle");
  }

  const doDraw = () => reveal(() => draw.mutateAsync({ categoryId, goalId }));
  // Warm-up (#57): deterministic deal of the smallest card — same filters,
  // same reveal, but a handed-out commitment instead of a gamble.
  const doWarmup = () => reveal(() => warmup.mutateAsync({ categoryId, goalId }));

  // The card renders from local state, so the PATCH response must be written
  // back into `result` — query invalidation alone would not refresh it.
  async function saveEdit(patch: NewTask) {
    if (!result?.task) return;
    const response = await updateTask.mutateAsync({ id: result.task.id, ...patch });
    setResult((prev) => (prev ? { ...prev, task: response.task } : prev));
    setEdited(true);
    setEditing(false);
  }

  async function deleteDrawn() {
    if (!result?.task) return;
    if (!confirm(`Delete "${result.task.title}"?`)) return;
    await deleteTask.mutateAsync(result.task.id);
    setResult(null);
    setEditing(false);
    setPhase("idle");
  }

  async function completeDrawn() {
    if (!result?.task) return;
    // No wasDrawn flag: the server derives the drawn-card bonus from the
    // persisted current draw (ADR-13), so it survives reloads too.
    const response = await updateTask.mutateAsync({ id: result.task.id, status: "done" });
    confetti({ particleCount: 120, spread: 75, origin: { y: 0.6 } });
    // Surface why the XP was higher (#57) alongside the confetti.
    if (response.bonus === "warmup") setBonusNote("🔰 Warm-up bonus: +25% XP");
    else if (response.bonus === "momentum") setBonusNote("⚡ Momentum bonus: +25% XP");
    setResult(null);
    setPhase("idle");
  }

  // "Not now" (issue #19): snooze or block the drawn card. The card leaves
  // the deck server-side and the PATCH handler eagerly clears the persisted
  // current-draw pointer (ADR-17), so a reload does not resurrect the card.
  async function snoozeDrawn(patch: { deferredUntil?: string; blocked?: boolean }) {
    if (!result?.task) return;
    await updateTask.mutateAsync({ id: result.task.id, ...patch });
    setSnoozing(false);
    setResult(null);
    setPhase("idle");
  }

  const task = result?.task ?? null;
  const category = task ? categories.data?.find((c) => c.id === task.categoryId) : null;

  // "▶ Start now" (issue #56): one click starts the timer AND drops into the
  // fullscreen focus view. The view itself is derived below, so re-entering
  // after Escape — the timer already runs on this card — must NOT start
  // again: that would close and reopen the entry, resetting the countdown
  // and splitting the tracked time for no reason.
  function startFocus() {
    if (!task) return;
    setSnoozing(false);
    setFocusExited(false);
    if (timer.data?.task.id !== task.id) startTimer.mutate(task.id);
  }

  // Focus is derived, never stored (ADR-29): the overlay shows exactly while
  // the running timer points at the drawn card. Stopping or switching the
  // timer elsewhere (second tab) collapses it back to the revealed card on
  // the next timer refetch — never a dead overlay.
  const view = resolveDrawView(
    phase === "revealed" ? (task?.id ?? null) : null,
    timer.data?.task.id ?? null,
    focusExited,
  );
  // AI card art (#27): kicked off by the reveal, never awaited by it. The
  // hook swallows every failure (incl. 503 degraded mode) into "no art".
  const cardArt = useCardArt(task?.id, phase === "revealed");
  const maxEffort = Number(settings.data?.max_draw_effort ?? 30);
  // An edit can push the drawn card out of the deck (effort too big/cleared,
  // status no longer open) — computed client-side, mirroring drawService.
  const nonDrawable =
    task != null && (task.status !== "open" || classifyTask(task, maxEffort) !== "ready");

  return (
    <div className="content" style={{ textAlign: "center" }}>
      <h1>Draw a card</h1>
      <p style={{ color: "var(--text-dim)" }}>
        Stop choosing. Draw one small task and just start.
      </p>

      <div className="draw-filters">
        <span
          className={`chip ${categoryId === undefined ? "active" : ""}`}
          onClick={() => setCategoryId(undefined)}
        >
          All
        </span>
        {categories.data?.map((c) => (
          <span
            key={c.id}
            className={`chip ${categoryId === c.id ? "active" : ""}`}
            onClick={() => setCategoryId(c.id)}
          >
            <span className="dot" style={{ background: c.color }} />
            {c.name}
          </span>
        ))}
        {goals.data && goals.data.length > 0 && (
          <select
            value={goalId ?? ""}
            onChange={(e) => setGoalId(e.target.value === "" ? undefined : Number(e.target.value))}
            style={{ padding: "2px 8px", fontSize: 13, borderRadius: 999 }}
          >
            <option value="">any goal</option>
            {goals.data.map((g) => (
              <option key={g.id} value={g.id}>
                🎯 {g.title}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="draw-scene">
        <div
          className={`draw-card ${phase === "revealed" ? "flipped" : ""} ${
            phase === "shuffling" ? "shuffling" : ""
          }`}
        >
          <div className="draw-face front" onClick={phase === "idle" ? doDraw : undefined}>
            🃏
            <div style={{ fontSize: 15, marginTop: 12, color: "var(--text-dim)" }}>
              {phase === "shuffling" ? "shuffling…" : "click to draw"}
            </div>
          </div>
          <div className="draw-face back">
            {/* Model-generated SVG is rendered exclusively as an <img> data
                URI (server-sanitized, too) — never dangerouslySetInnerHTML.
                The scrim keeps title, badges and odds legible over any art. */}
            {task && cardArt.data?.svg && (
              <>
                <img
                  className="draw-art"
                  alt=""
                  aria-hidden="true"
                  src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(cardArt.data.svg)}`}
                />
                <div className="draw-art-scrim" />
              </>
            )}
            {task && (
              <>
                {category && (
                  <span className="chip">
                    <span className="dot" style={{ background: category.color }} />
                    {category.name}
                  </span>
                )}
                <h2>{task.title}</h2>
                {task.description && (
                  <p style={{ color: "var(--text-dim)", margin: 0 }}>{task.description}</p>
                )}
                <TaskBadges task={task} />
                {/* Warm-up deal (#57): badge + bonus-window hint. No odds
                    line renders — a deal has no probability by construction. */}
                {result?.warmup && (
                  <div className="warmup-note">
                    <span className="chip warmup-chip">🔰 Warm-up</span>
                    <div className="warmup-window-hint">
                      finish within ~{result.warmup.windowMinutes} min for a bonus
                    </div>
                  </div>
                )}
                {nonDrawable && (
                  <div className="draw-hint">
                    This card is now out of the deck — complete, snooze, or delete it to draw a
                    fresh card.
                  </div>
                )}
                {/* The odds reflect the original draw; hide them once the
                    task was edited instead of showing a stale number. */}
                {!edited && result?.probability != null && (
                  <div className="draw-chance">
                    {Math.round(result.probability * 100)}% draw chance · {result.poolSize} card
                    {result.poolSize === 1 ? "" : "s"} in the deck
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Warm-up (#57): the "I can't start" escape hatch, offered on the IDLE
          deck only (including the empty-deck state) — never while a card is
          revealed, because the deal is a commitment, not a re-roll (#88). */}
      {phase === "idle" && (
        <div className="warmup-cta">
          <button
            disabled={!warmupStatus.data?.available || warmup.isPending}
            onClick={doWarmup}
            title="Deterministically deal the smallest eligible card"
          >
            🔰 Warm-up — deal my smallest card
          </button>
          {warmupStatus.data?.available === false && warmupStatus.data.nextWarmupAt && (
            <div className="warmup-next-hint">
              next warm-up at {new Date(warmupStatus.data.nextWarmupAt).toLocaleString()}
            </div>
          )}
          {bonusNote && <div className="draw-bonus-note">{bonusNote}</div>}
        </div>
      )}

      {phase === "revealed" && task && !editing && (
        <div className="draw-actions">
          <button className={nonDrawable ? undefined : "primary"} onClick={startFocus}>
            ▶ Start now
          </button>
          <button onClick={completeDrawn}>✓ Done</button>
          {/* When an edit pushed the card out of the deck, "Not now" takes
              over as the suggested action — the legitimate escape hatch. */}
          <button
            className={nonDrawable ? "primary" : undefined}
            onClick={() => setSnoozing((s) => !s)}
            title="Take this card out of the deck"
          >
            💤 Not now
          </button>
          <button
            onClick={() => {
              setSnoozing(false);
              setEditing(true);
            }}
          >
            ✎ Edit
          </button>
          <button onClick={deleteDrawn} title="Delete task">
            🗑 Delete
          </button>
          {/* Deliberately no "Draw again" (#88): the draw is a commitment —
              re-rolling would mean fishing for a comfortable card. The card
              leaves the screen only by being resolved: completed, snoozed or
              blocked ("Not now"), or deleted. Filter changes while a card is
              revealed apply to the NEXT draw. */}
        </div>
      )}

      {phase === "revealed" && task && !editing && snoozing && (
        <div className="panel" style={{ maxWidth: 680, margin: "8px auto 0" }}>
          <p style={{ color: "var(--text-dim)", marginTop: 0, fontSize: 13 }}>
            Out of the deck until…
          </p>
          <SnoozeMenu
            onSnooze={(iso) => snoozeDrawn({ deferredUntil: iso })}
            onBlock={() => snoozeDrawn({ blocked: true })}
          />
        </div>
      )}

      {phase === "revealed" && task && editing && (
        <div className="panel" style={{ maxWidth: 680, margin: "8px auto 0", textAlign: "left" }}>
          <TaskForm
            key={task.id}
            categories={categories.data ?? []}
            // No goal select mid-draw (#88): the page's goal filter sits right
            // above the card, so the form's select read as duplication. Goal
            // (re)linking lives on the Tasks page rows (#17). Omitting `goals`
            // hides the select — the subtask-variant mechanism — while the
            // stored goalId is resent unchanged on save.
            initial={task}
            autoFocus
            submitLabel="Save"
            onSubmit={saveEdit}
            onCancel={() => setEditing(false)}
          />
        </div>
      )}

      {/* In-face actions ARE the DrawPage actions (no duplicated controls):
          ✓ Done is completeDrawn (entry closed server-side, ADR-12), ■ Stop
          is the timer stop — the persisted draw is untouched, so the card
          stays restorable underneath. Escape exits the view only. */}
      {view === "focus" && task && timer.data && (
        <FocusOverlay
          task={task}
          category={category ?? null}
          startedAt={timer.data.entry.startedAt}
          onDone={completeDrawn}
          onStop={() => stopTimer.mutate()}
          onExit={() => setFocusExited(true)}
        />
      )}

      <TrophyDeck />

      {phase === "idle" && result && !result.task && (
        <div className="panel" style={{ maxWidth: 420, margin: "0 auto" }}>
          {result.reason === "cooling_down" ? (
            <p>
              Your smallest cards were dealt just recently and are still cooling down — draw
              normally, or give them a few minutes.
            </p>
          ) : result.reason === "warmup_unavailable" ? (
            <p>
              The warm-up is used up for now
              {result.nextWarmupAt
                ? ` — the next one opens at ${new Date(result.nextWarmupAt).toLocaleString()}`
                : ""}
              .
            </p>
          ) : result.reason === "all_outside_window" ? (
            <p>
              Everything left is scheduled for later — those cards come back on their own when
              their <Link to="/capture" style={{ color: "var(--accent)" }}>availability window</Link> opens.
            </p>
          ) : result.reason === "all_too_big" ? (
            <p>
              Everything left is too big or unestimated. <Link to="/capture" style={{ color: "var(--accent)" }}>Break something down</Link> to refill the deck.
            </p>
          ) : (
            <p>
              The deck is empty. <Link to="/capture" style={{ color: "var(--accent)" }}>Capture a task</Link> to get started.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
