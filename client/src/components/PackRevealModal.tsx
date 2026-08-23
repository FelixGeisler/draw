import { useEffect, useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useModalFocus } from "../hooks/useModalFocus";
import { PACK_BONUS_LABELS } from "../hooks/useShop";
import { resetCelebration } from "../lib/celebrate";
import type {
  PackRevealAction,
  PackRevealIdentity,
  PackRevealSession,
} from "./packRevealState";
import "./PackRevealModal.css";

function BackgroundCard({ session }: { session: PackRevealSession }) {
  const { opening } = session.result;
  return (
    <article className="pack-reveal-card pack-reveal-card-face" aria-label="Background card">
      <span
        className="draw-face front pack-reveal-background-paint"
        data-back={opening.back.key === "classic" ? undefined : opening.back.key}
        aria-hidden="true"
      />
      <div className="pack-reveal-card-copy">
        <strong>{opening.back.name}</strong>
        <span className={`pack-reveal-rarity tier-${opening.back.rarity}`}>
          {opening.back.rarity}
        </span>
        <span>{opening.duplicate ? "Duplicate" : "New background"}</span>
        <span>Duplicate refund: {opening.duplicateRefundGold} Gold</span>
      </div>
    </article>
  );
}

function BonusCard({ session }: { session: PackRevealSession }) {
  const bonus = session.result.opening.bonus;
  if (bonus === "none") return null;
  const label = PACK_BONUS_LABELS[bonus];
  return (
    <article
      className={`pack-reveal-card pack-reveal-card-face pack-reveal-bonus bonus-${bonus}`}
      aria-label="Bonus card"
    >
      <span className="pack-reveal-bonus-visual" aria-hidden="true" />
      <strong>{label}</strong>
    </article>
  );
}

function backgroundAnnouncement(session: PackRevealSession): string {
  const { opening } = session.result;
  return `${opening.back.name}. ${opening.back.rarity}. ${
    opening.duplicate ? "Duplicate" : "New background"
  }. Duplicate refund: ${opening.duplicateRefundGold} Gold.`;
}

function announcement(session: PackRevealSession): string {
  if (session.stage === "background-ready") return "Background ready to reveal.";
  if (session.stage === "bonus-ready") {
    return `${backgroundAnnouncement(session)} Bonus ready to reveal.`;
  }
  const bonus = session.result.opening.bonus;
  if (session.completion === "skip" || session.completion === "reduced") {
    return `All cards revealed. ${backgroundAnnouncement(session)}${
      bonus === "none" ? "" : ` ${PACK_BONUS_LABELS[bonus]}.`
    }`;
  }
  return bonus === "none"
    ? `Background revealed. ${backgroundAnnouncement(session)}`
    : `Bonus revealed. ${PACK_BONUS_LABELS[bonus]}.`;
}

export function PackRevealModal({
  session,
  onAction,
  onClose,
}: {
  session: PackRevealSession;
  onAction: (identity: PackRevealIdentity, action: PackRevealAction) => void;
  onClose: (identity: PackRevealIdentity) => void;
}) {
  const dialogRef = useModalFocus();
  const nextActionRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => () => resetCelebration(), []);

  useEffect(() => {
    (session.stage === "complete" ? closeRef : nextActionRef).current?.focus();
  }, [session.stage]);

  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose(session.identity);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, session.identity]);

  function trapTab(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") return;
    const buttons = Array.from(
      dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
    );
    if (buttons.length === 0) return;
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const backgroundVisible = session.stage !== "background-ready";
  const bonusVisible = session.stage === "complete" && session.result.opening.bonus !== "none";

  return createPortal(
    <div className="pack-reveal-backdrop">
      <div
        ref={dialogRef}
        className={`pack-reveal-dialog ${session.reducedMotion ? "reduced-motion" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="Pack opening"
        tabIndex={-1}
        onKeyDown={trapTab}
      >
        <h2>Pack opening</h2>
        <p className="pack-reveal-status" role="status" aria-live="polite" aria-atomic="true">
          {announcement(session)}
        </p>

        <div className="pack-reveal-cards" data-testid="pack-reveal-cards">
          {backgroundVisible ? (
            <BackgroundCard session={session} />
          ) : (
            <button
              ref={nextActionRef}
              type="button"
              className="pack-reveal-card pack-reveal-card-back"
              aria-label="Reveal background"
              onClick={() => onAction(session.identity, "reveal-background")}
            >
              <span aria-hidden="true">Background card</span>
            </button>
          )}

          {session.stage === "bonus-ready" && (
            <button
              ref={nextActionRef}
              type="button"
              className="pack-reveal-card pack-reveal-card-back pack-reveal-bonus-back"
              aria-label="Reveal bonus"
              onClick={() => onAction(session.identity, "reveal-bonus")}
            >
              <span aria-hidden="true">Bonus card</span>
            </button>
          )}
          {bonusVisible && <BonusCard session={session} />}
        </div>

        <div className="pack-reveal-actions">
          {session.stage !== "complete" && (
            <button
              type="button"
              aria-label="Skip reveal"
              onClick={() => onAction(session.identity, "skip")}
            >
              Skip reveal
            </button>
          )}
          <button
            ref={closeRef}
            type="button"
            aria-label="Close pack reveal"
            onClick={() => onClose(session.identity)}
          >
            Close pack reveal
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
