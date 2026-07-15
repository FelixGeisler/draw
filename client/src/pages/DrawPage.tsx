import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import confetti from "canvas-confetti";
import { useCategories, useDeleteTask, useSettings, useUpdateTask } from "../hooks/useTasks";
import { useGoals } from "../hooks/useGoals";
import {
  useCurrentDraw,
  useCurrentDrawCache,
  useDraw,
  useWarmupDraw,
  useWarmupStatus,
  type DrawResponse,
} from "../hooks/useDraw";
import { useCardArt, useRegenerateCardArt } from "../hooks/useAi";
import { useCurrentTimer, useStartTimer, useStopTimer } from "../hooks/useTimer";
import { CardFrame } from "../components/CardFrame";
import { FocusOverlay } from "../components/FocusOverlay";
import { SnoozeMenu } from "../components/SnoozeMenu";
import { TaskBadges } from "../components/TaskBadges";
import { TaskForm } from "../components/TaskForm";
import { TrophyDeck } from "../components/TrophyDeck";
import { liveTrackedMinutes } from "../lib/cardFrame";
import { classifyTask } from "../lib/drawable";
import { resolveDrawnCard } from "../lib/drawnCard";
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
  const [shuffling, setShuffling] = useState(false);
  // The latest draw response of THIS session: the odds line and the
  // empty-deck reason render from it, and its task doubles as the session
  // snapshot for resolveDrawnCard's two exceptions. The standing card itself
  // is NOT this state — see the derivation below (#110).
  const [result, setResult] = useState<DrawResponse | null>(null);
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState(false);
  // An on-page edit pushed the card out of the deck (#88): the pointer is
  // forfeit server-side (cleared lazily on the next GET), but the session
  // keeps the card with the resolve hint until it is resolved here — the
  // draw is a commitment, an edit must not become a hidden re-roll. Sticky
  // across further edits (editing the card back into the deck cannot
  // resurrect the cleared pointer); reset by resolution and by a new draw.
  const [editedOutOfDeck, setEditedOutOfDeck] = useState(false);
  const [snoozing, setSnoozing] = useState(false);
  // Escape peeked out of the focus view (issue #56). Session-local on
  // purpose: the view itself is DERIVED from timer + current draw (ADR-29),
  // so a reload while the timer runs on the drawn card re-enters focus.
  const [focusExited, setFocusExited] = useState(false);
  // Why the last completion paid extra (#57) — shown once the card is gone,
  // cleared by the next draw/deal.
  const [bonusNote, setBonusNote] = useState<string | null>(null);

  // The standing card DERIVES from the server-persisted current draw (#110,
  // extending ADR-29): a reload restores it revealed, no shuffle (issue #25,
  // mirroring the TimerBar) — and a completion, snooze, or delete on ANY
  // surface (TimerBar, Tasks page, MCP, a second tab) clears the pointer, so
  // the next refetch dismisses the card without a second ✓ Done.
  const currentDraw = useCurrentDraw();
  const setCurrentDraw = useCurrentDrawCache();
  const maxEffort = Number(settings.data?.max_draw_effort ?? 30);
  const task = resolveDrawnCard({
    shuffling,
    serverTask: currentDraw.data === undefined ? undefined : (currentDraw.data?.task ?? null),
    sessionTask: result?.task ?? null,
    editedOutOfDeck,
  });
  const phase: Phase = shuffling ? "shuffling" : task ? "revealed" : "idle";
  // The warm-up marker rides GET /api/draw/current (#57), so the badge and
  // window hint survive reloads exactly like the derived card itself; the
  // session's deal response bridges any gap before the cache settles.
  const warmupInfo =
    task == null
      ? undefined
      : currentDraw.data?.warmup?.taskId === task.id
        ? currentDraw.data.warmup
        : result?.warmup?.taskId === task.id
          ? result.warmup
          : undefined;

  async function reveal(mutate: () => Promise<DrawResponse>) {
    setShuffling(true);
    setResult(null);
    setEditing(false);
    setEdited(false);
    setEditedOutOfDeck(false);
    setSnoozing(false);
    setFocusExited(false);
    setBonusNote(null);
    const [response] = await Promise.all([
      mutate(),
      new Promise((r) => setTimeout(r, 450)), // let the shuffle play
    ]);
    // The reveal works off the mutation response: both draw hooks write it
    // through to the current-draw cache on success, so ending the shuffle
    // flips straight to the drawn card — no refetch race in the animation.
    setResult(response);
    setShuffling(false);
  }

  const doDraw = () => reveal(() => draw.mutateAsync({ categoryId, goalId }));
  // Warm-up (#57): deterministic deal of the smallest card — same filters,
  // same reveal, but a handed-out commitment instead of a gamble. The deal
  // persists the same current-draw pointer, so the derived card picks it up
  // exactly like a regular draw.
  const doWarmup = () => reveal(() => warmup.mutateAsync({ categoryId, goalId }));

  async function saveEdit(patch: NewTask) {
    if (!task) return;
    const response = await updateTask.mutateAsync({ id: task.id, ...patch });
    // The PATCH response settles the card's fate ahead of the confirming
    // refetch: still drawable → it IS the current draw (pointer intact
    // server-side); edited out of the deck → the pointer is forfeit and the
    // sticky flag holds the session's card (#88, see above). The PATCH task
    // shape has no trackedMinutes (draw payloads only) — carry the standing
    // card's over so the DEF stat (#115) never blinks out across an edit.
    const patched = { ...response.task, trackedMinutes: task.trackedMinutes };
    setResult({ task: patched });
    if (response.task.status !== "open" || classifyTask(response.task, maxEffort) !== "ready") {
      setEditedOutOfDeck(true);
    } else if (!editedOutOfDeck) {
      // Keep the warm-up marker (#57) riding the cache: an in-deck edit
      // leaves the pointer — and thus the marker — intact server-side.
      setCurrentDraw({ task: patched, warmup: warmupInfo });
    }
    setEdited(true);
    setEditing(false);
  }

  async function deleteDrawn() {
    if (!task) return;
    if (!confirm(`Delete "${task.title}"?`)) return;
    await deleteTask.mutateAsync(task.id);
    // The delete cleared the pointer server-side; write that through so the
    // card flips back instantly instead of after the confirming refetch.
    setCurrentDraw(null);
    setResult(null);
    setEditedOutOfDeck(false);
    setEditing(false);
  }

  async function completeDrawn() {
    if (!task) return;
    // No wasDrawn flag: the server derives the drawn-card bonus from the
    // persisted current draw (ADR-13), so it survives reloads too.
    const response = await updateTask.mutateAsync({ id: task.id, status: "done" });
    // Celebration belongs to the acting surface (#110): confetti fires for
    // the page's own ✓ Done only — a completion arriving from the TimerBar
    // or the Tasks page dismisses the derived card without fanfare.
    confetti({ particleCount: 120, spread: 75, origin: { y: 0.6 } });
    // Surface why the XP was higher (#57) alongside the confetti.
    if (response.bonus === "warmup") setBonusNote("🔰 Warm-up bonus: +25% XP");
    else if (response.bonus === "momentum") setBonusNote("⚡ Momentum bonus: +25% XP");
    setCurrentDraw(null);
    setResult(null);
    setEditedOutOfDeck(false);
  }

  // "Not now" (issue #19): snooze or block the drawn card. The card leaves
  // the deck server-side and the PATCH handler eagerly clears the persisted
  // current-draw pointer (ADR-17), so a reload does not resurrect the card.
  async function snoozeDrawn(patch: { deferredUntil?: string; blocked?: boolean }) {
    if (!task) return;
    await updateTask.mutateAsync({ id: task.id, ...patch });
    setCurrentDraw(null);
    setSnoozing(false);
    setResult(null);
    setEditedOutOfDeck(false);
  }

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
  // Regenerate (#113): replaces the art server-side, keeps the old one on
  // failure — as silent as the art itself. Rendered only when art exists, so
  // degraded mode never shows the button at all. The task id travels as the
  // mutation variable (pinned at mutate() time), so a regenerate that
  // resolves after the drawn task changed still lands in the RIGHT cache
  // entry — and the same variable scopes the pending state to this card: a
  // card drawn while the previous card's regenerate is still in flight gets
  // a live ↻, not the leftover spinner of a mutation that was never its own.
  const regenArt = useRegenerateCardArt();
  const regenPending = regenArt.isPending && regenArt.variables === task?.id;
  // An edit can push the drawn card out of the deck (effort too big/cleared,
  // status no longer open) — computed client-side, mirroring drawService.
  const nonDrawable =
    task != null && (task.status !== "open" || classifyTask(task, maxEffort) !== "ready");

  // DEF = tracked minutes (#115), live: the draw payload carries the CLOSED
  // entries' sum; while the timer runs on THIS card the running entry's
  // elapsed minutes are added client-side, re-read every 15s so the stat
  // grows as you fight the card without refetching anything. Stopping the
  // timer folds the entry into the server sum (useStopTimer invalidates the
  // current draw).
  const runningStartedAt =
    task != null && timer.data?.task.id === task.id ? timer.data.entry.startedAt : null;
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (runningStartedAt == null) return;
    setNowMs(Date.now());
    const interval = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(interval);
  }, [runningStartedAt]);
  const defMinutes =
    task?.trackedMinutes != null
      ? liveTrackedMinutes(task.trackedMinutes, runningStartedAt, nowMs)
      : null;

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
            {/* TCG frame (#115): level stars = impact (goal-linked only,
                ADR-4), type line = category, ATK = estimated minutes, DEF =
                tracked minutes (live), flavor = description; the #113 art
                fades into the portrait window, gradient placeholder without
                it. The category chip and effort/star badges the face used to
                carry are absorbed by the frame — no duplicated data. */}
            {task && (
              <CardFrame
                title={task.title}
                category={category ?? null}
                impact={task.impact}
                goalLinked={task.goalId != null}
                artSvg={cardArt.data?.svg}
                // dataUpdatedAt changes when a regenerate swaps the cache
                // entry — remounting replays the fade-in for the new art.
                artKey={cardArt.dataUpdatedAt}
                atk={task.effortMinutes}
                def={defMinutes}
                flavor={task.description}
              >
                <TaskBadges task={task} showStars={false} showEffort={false} />
                {/* Warm-up deal (#57): badge + bonus-window hint. No odds
                    line renders — a deal has no probability by construction. */}
                {warmupInfo && (
                  <div className="warmup-note">
                    <span className="chip warmup-chip">🔰 Warm-up</span>
                    <div className="warmup-window-hint">
                      finish within ~{warmupInfo.windowMinutes} min for a bonus
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
                    task was edited — and never pin them under a card the
                    session did not draw (restored or swapped elsewhere). */}
                {!edited && result?.probability != null && result.task?.id === task.id && (
                  <div className="draw-chance">
                    {Math.round(result.probability * 100)}% draw chance · {result.poolSize} card
                    {result.poolSize === 1 ? "" : "s"} in the deck
                  </div>
                )}
              </CardFrame>
            )}
          </div>
        </div>
        {/* Regenerate (#113) overlays the scene INSTEAD of living inside the
            flipped face: elements in the backface-hidden 3D flip context are
            not reliably hit-testable (Chromium), so the one interactive
            control on the card sits in plain 2D above it. Rendered only when
            there is art to replace — degraded mode never shows it. */}
        {phase === "revealed" && task && cardArt.data?.svg && (
          <button
            className={`draw-art-regen ${regenPending ? "pending" : ""}`}
            title="Regenerate artwork"
            aria-label="Regenerate artwork"
            disabled={regenPending}
            onClick={() => regenArt.mutate(task.id)}
          >
            ↻
          </button>
        )}
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
