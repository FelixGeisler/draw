import { useEffect, useState } from "react";
import { useGamification } from "../hooks/useGamification";
import { achievementRarity } from "../lib/achievementRarity";
import { celebrate, prefersReducedMotion } from "../lib/celebrate";
import { AchievementCard, type AchievementCardData } from "./AchievementCard";
import "./AchievementToast.css";

interface Unlock {
  id: number;
  key: string;
}

let unlockId = 1;

/**
 * The unlock celebration (#124 toast → #224 staged reveal). One coordinator
 * owns the queue and plays unlocks ONE AT A TIME — a completion can unlock
 * several keys, and two celebrations at once celebrate nothing. The surface
 * climbs the rarity ladder (owner's pick from the #224 mockups):
 *
 *   common  → the corner toast, charged: spring landing, glow pulses, a
 *             small burst. Frequent small unlocks never interrupt work.
 *   rare+   → CENTER STAGE: scrim dims the app, the card deals large and
 *             flips with a confetti burst, holds, then flies toward the
 *             corner the toast lives in and the stage releases.
 *
 * Reduced motion (the #148 single-door rule): both surfaces become a static
 * appear — no flip, no confetti, no flight — with the same timings and the
 * same manual dismissals.
 *
 * Focus overlay: the stage sits at z-index 85, BELOW FocusOverlay's 90 — a
 * mid-focus unlock must never interrupt the one thing this app exists to
 * protect. The corner toast keeps its historical z-index 100.
 */
export function AchievementToast() {
  const { data } = useGamification();
  const [queue, setQueue] = useState<Unlock[]>([]);

  useEffect(() => {
    function onUnlock(e: Event) {
      const keys = (e as CustomEvent<string[]>).detail;
      setQueue((q) => [...q, ...keys.map((key) => ({ id: unlockId++, key }))]);
    }
    window.addEventListener("achievements-unlocked", onUnlock);
    return () => window.removeEventListener("achievements-unlocked", onUnlock);
  }, []);

  const head = queue[0];
  if (!head) return null;

  const def = data?.achievements.find((a) => a.key === head.key);
  const advance = () => setQueue((q) => q.slice(1));
  // Payload not caught up yet → no card to deal large; the quiet toast with
  // its key-name fallback is the honest surface for that gap.
  const stage = def != null && achievementRarity(head.key) !== "common";

  // The id (not the key) keys the element: a remount is exactly what re-arms
  // the animation for a repeat unlock of the same achievement.
  return stage ? (
    <UnlockStage key={head.id} def={def!} onDone={advance} />
  ) : (
    <div className="ach-toast-stack">
      <ToastCard key={head.id} def={def} fallbackKey={head.key} onDone={advance} />
    </div>
  );
}

/** The charged corner toast — commons (#224 variant B). */
function ToastCard({
  def,
  fallbackKey,
  onDone,
}: {
  def?: AchievementCardData;
  fallbackKey: string;
  onDone: () => void;
}) {
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    // One tick face-down, then the flip; the transition is motion-gated in
    // CSS, so reduced motion is a static appear.
    const flip = setTimeout(() => setRevealed(true), 90);
    // A small burst out of the corner — celebrate() is the one door to
    // canvas-confetti (#148) and self-gates on reduced motion.
    const burst = setTimeout(
      () =>
        celebrate({
          particleCount: 30,
          spread: 60,
          startVelocity: 24,
          ticks: 100,
          origin: { x: 0.92, y: 0.88 },
        }),
      450,
    );
    const done = setTimeout(onDone, 4000);
    return () => {
      clearTimeout(flip);
      clearTimeout(burst);
      clearTimeout(done);
    };
    // Mount-only on purpose: the id-keyed remount is the re-arm mechanism.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="panel ach-toast">
      <div className="ach-toast-heading">🏆 Achievement unlocked</div>
      {def ? (
        <div className="ach-toast-scene">
          <div className={`ach-toast-flip ${revealed ? "revealed" : ""}`}>
            {/* The card back: the same weave a locked card and the undrawn
                draw card wear. Hidden from AT — the face carries the text. */}
            <div className="ach-toast-face back" aria-hidden="true" />
            <div className="ach-toast-face front">
              <AchievementCard achievement={def} />
            </div>
          </div>
        </div>
      ) : (
        // The payload has not caught up with the unlock event yet: name the
        // key rather than dealing a blank card.
        <div style={{ fontSize: 16, marginTop: 4 }}>{fallbackKey}</div>
      )}
    </div>
  );
}

/** Center stage — rare and above (#224 variant A). */
function UnlockStage({ def, onDone }: { def: AchievementCardData; onDone: () => void }) {
  const reduce = prefersReducedMotion();
  const [revealed, setRevealed] = useState(reduce);
  const [lit, setLit] = useState(reduce);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (reduce) {
      // Static appear: face-up under the heading, the same generous
      // auto-dismiss, manual dismiss still available. Nothing moves.
      const done = setTimeout(onDone, 4000);
      return () => clearTimeout(done);
    }
    const raf = requestAnimationFrame(() => setLit(true));
    const flip = setTimeout(() => setRevealed(true), 450);
    const burst = setTimeout(
      () =>
        celebrate({
          particleCount: 90,
          spread: 100,
          startVelocity: 34,
          ticks: 160,
          origin: { x: 0.5, y: 0.45 },
        }),
      800,
    );
    const leave = setTimeout(dismiss, 3200);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(flip);
      clearTimeout(burst);
      clearTimeout(leave);
    };
    // Mount-only on purpose — see ToastCard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Idempotent: the auto-timer, a click and Escape can race; only the first
  // caller starts the flyout and schedules the release.
  function dismiss() {
    if (reduce) {
      onDone();
      return;
    }
    setLeaving((already) => {
      if (!already) setTimeout(onDone, 520);
      return true;
    });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") dismiss();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className={["ach-stage", lit ? "lit" : "", leaving ? "leaving" : ""]
        .filter(Boolean)
        .join(" ")}
      onClick={dismiss}
      role="status"
    >
      <div className="ach-stage-inner">
        <span className="ach-stage-glow" aria-hidden="true" />
        <div className="ach-stage-heading">★ Achievement unlocked ★</div>
        <div className="ach-stage-scene">
          <div className={`ach-stage-flip ${revealed ? "revealed" : ""}`}>
            <div className="ach-toast-face back" aria-hidden="true" />
            <div className="ach-toast-face front">
              <AchievementCard achievement={def} />
            </div>
          </div>
        </div>
        <div className="ach-stage-hint">click anywhere · Esc</div>
      </div>
    </div>
  );
}
