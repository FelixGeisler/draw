import { useEffect, useState } from "react";
import { useGamification } from "../hooks/useGamification";
import { AchievementCard, type AchievementCardData } from "./AchievementCard";
import "./AchievementToast.css";

interface Toast {
  id: number;
  key: string;
}

let toastId = 1;

/**
 * One unlock, presented as the card it actually is (#124): the toast deals a
 * face-down card and flips it, so the achievement arrives the same way every
 * other card in this app does. The heading stays real text ("🏆 Achievement
 * unlocked") — the card face is paint, and a toast still has to mean something
 * to a screen reader.
 */
function AchievementToastCard({ def, fallbackKey }: { def?: AchievementCardData; fallbackKey: string }) {
  const [revealed, setRevealed] = useState(false);

  // One tick face-down, then the flip. The transition is gated behind
  // prefers-reduced-motion: no-preference (AchievementToast.css), so reduced
  // motion turns this into a static appear — the card is simply there, face-up.
  useEffect(() => {
    const t = setTimeout(() => setRevealed(true), 90);
    return () => clearTimeout(t);
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

export function AchievementToast() {
  const { data } = useGamification();
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    function onUnlock(e: Event) {
      const keys = (e as CustomEvent<string[]>).detail;
      setToasts((ts) => [...ts, ...keys.map((key) => ({ id: toastId++, key }))]);
    }
    window.addEventListener("achievements-unlocked", onUnlock);
    return () => window.removeEventListener("achievements-unlocked", onUnlock);
  }, []);

  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = setTimeout(() => setToasts((ts) => ts.slice(1)), 4000);
    return () => clearTimeout(timer);
  }, [toasts]);

  if (toasts.length === 0) return null;

  return (
    <div className="ach-toast-stack">
      {toasts.map((toast) => (
        <AchievementToastCard
          // The id (not the key) keys the list: a remount is exactly what
          // re-arms the flip for a second unlock of the same achievement.
          key={toast.id}
          def={data?.achievements.find((a) => a.key === toast.key)}
          fallbackKey={toast.key}
        />
      ))}
    </div>
  );
}
