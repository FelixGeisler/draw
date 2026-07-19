import { useId, useState } from "react";
import { achievementArt } from "../lib/achievementArt";
import { achievementRarity } from "../lib/achievementRarity";
import { celebrate } from "../lib/celebrate";
import { useClaimAchievement, useUpdateAchievement } from "../hooks/useGamification";
import { buildAchievementPatch, resetAchievementPatch } from "../lib/achievementEdit";
import { claimXpForKey } from "../../../shared/achievementTiers";
import "./AchievementCard.css";

/** Exactly the achievement shape the /api/gamification payload delivers
 *  (useGamification.GamificationState). */
export interface AchievementCardData {
  key: string;
  /** Display title — the user's override (#177) COALESCE'd onto the default. */
  title: string;
  emoji: string;
  /** Display description — the user's override (#177) or the default. */
  description: string;
  /** Curated out of the main collection (#177) — never affects unlock/claim. */
  hidden: boolean;
  /** Any display override is set — gates the "Reset to default" button (#177). */
  customized: boolean;
  unlockedAt: string | null;
  /** Claim-for-XP (#156): set once claimed, null while claimable or locked. */
  claimedAt: string | null;
  /** XP stamped at claim time, null until claimed. */
  claimXp: number | null;
  /** Chain progress toward the threshold, null for a one-off. */
  progress: { current: number; target: number } | null;
}

/**
 * One collectible achievement card (issue #124, extended for the chains and
 * claim-for-XP of #156, and the display customization of #177) — the single
 * card face, shared by the Stats page collection and the unlock toast so a
 * just-earned card and the same card on the shelf are literally the same
 * component.
 *
 * Speaks the #123 card language and nothing else (ADR-33): full-bleed art under
 * a legibility scrim, the name and — once earned — the date, plus the rarity
 * sheen. No ATK/DEF box, no type line, no level-star row; the rejected TCG
 * frame stays dead.
 *
 * The face shows the NAME ONLY (#177). The criteria/description are no longer a
 * permanent caption line — they reveal on hover/focus as a styled overlay,
 * focus-reachable via the edit button's `aria-describedby`. Unlocked = face-up;
 * locked = face-DOWN (the card-back weave over a darkened silhouette) with a
 * progress bar on a chain card. An unlocked-but-unclaimed card shows a Claim
 * affordance (only where `claimable` is set — the transient toast never offers
 * it). When `editable`, an ✎ button opens an inline editor to rename/rewrite/
 * hide the card (display only — unlock/claim/XP untouched, ADR-44).
 */
export function AchievementCard({
  achievement,
  className,
  claimable = false,
  editable = false,
}: {
  achievement: AchievementCardData;
  className?: string;
  /** Render the Claim button on an unlocked+unclaimed card. Off in the toast. */
  claimable?: boolean;
  /** Render the ✎ editor + description reveal. On in the collection, off in the toast. */
  editable?: boolean;
}) {
  const rarity = achievementRarity(achievement.key);
  const art = achievementArt(achievement.key);
  const unlocked = achievement.unlockedAt != null;
  const claim = useClaimAchievement();
  const update = useUpdateAchievement();
  const descId = useId();

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(achievement.title);
  const [desc, setDesc] = useState(achievement.description);
  const [hide, setHide] = useState(achievement.hidden);

  const showClaim = claimable && unlocked && achievement.claimedAt == null;
  // Locked chain cards get a progress bar; one-offs (progress null) do not.
  const showProgress = !unlocked && achievement.progress != null;

  function onClaim() {
    if (claim.isPending) return;
    claim.mutate(achievement.key, {
      // A small, reduced-motion-gated burst — the celebrate helper is the one
      // door to canvas-confetti (#148), so it self-gates.
      onSuccess: () => celebrate({ particleCount: 45, spread: 55, startVelocity: 28, ticks: 120 }),
    });
  }

  function openEditor() {
    // Seed the form from the current DISPLAYED values (already COALESCE'd), so
    // saving an untouched form is a no-op the server folds back to default.
    setName(achievement.title);
    setDesc(achievement.description);
    setHide(achievement.hidden);
    setEditing(true);
  }

  function onSave() {
    if (update.isPending) return;
    update.mutate(
      { key: achievement.key, ...buildAchievementPatch({ title: name, description: desc, hidden: hide }) },
      { onSuccess: () => setEditing(false) },
    );
  }

  function onReset() {
    if (update.isPending) return;
    update.mutate(
      { key: achievement.key, ...resetAchievementPatch() },
      { onSuccess: () => setEditing(false) },
    );
  }

  return (
    <div
      // Common carries NO rarity class at all (the trophy pile's "none"
      // convention) — plain is the absence of a sheen, not a tier of one.
      className={[
        "ach-card",
        unlocked ? "unlocked" : "locked",
        rarity !== "common" ? `rarity-${rarity}` : "",
        editing ? "editing" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-key={achievement.key}
      data-rarity={rarity}
    >
      <div className="ach-card-inner">
        {/* Full-bleed committed art under the scrim and the text (#124),
            absolutely positioned overlay layers only. Without art the
            gradient face stands alone with the achievement's emoji — the
            same degraded grace the task cards give a missing card-art row
            (ADR-33 e). New chain keys ship on this glyph fallback. */}
        {art ? (
          <>
            <img className="ach-art" src={art} alt="" aria-hidden="true" />
            <div className="ach-art-scrim" />
          </>
        ) : (
          <div className="ach-glyph" aria-hidden="true">
            {achievement.emoji}
          </div>
        )}

        <div className="ach-card-body">
          <div className="ach-name">{achievement.title}</div>
          {unlocked && (
            <div className="ach-date">unlocked {achievement.unlockedAt!.slice(0, 10)}</div>
          )}

          {showProgress && (
            <div
              className="ach-progress"
              role="progressbar"
              aria-valuenow={achievement.progress!.current}
              aria-valuemin={0}
              aria-valuemax={achievement.progress!.target}
            >
              <div
                className="ach-progress-fill"
                style={{
                  width: `${Math.min(
                    100,
                    (achievement.progress!.current / achievement.progress!.target) * 100,
                  )}%`,
                }}
              />
              <span className="ach-progress-label">
                {achievement.progress!.current}/{achievement.progress!.target}
              </span>
            </div>
          )}

          {showClaim && (
            <button
              type="button"
              className="ach-claim"
              onClick={onClaim}
              disabled={claim.isPending}
            >
              Claim +{claimXpForKey(achievement.key)} XP
            </button>
          )}
          {unlocked && achievement.claimedAt != null && (
            <div className="ach-claimed">claimed +{achievement.claimXp} XP</div>
          )}
        </div>

        {/* Description reveal (#177): the criteria/description as a styled panel
            over the art, revealed on hover/focus — no longer a permanent caption
            line. Focus-reachable: the ✎ button's aria-describedby points here, so
            a keyboard user hears it on focus. pointer-events: none so it never
            eats a click on the name/claim below. */}
        {editable && (
          <div className="ach-desc" id={descId} role="note">
            {achievement.description}
          </div>
        )}

        {/* ✎ editor affordance (#177) — a real button, revealed on hover/focus.
            Opacity-hidden (not display:none) keeps it in the tab order, so
            focusing it flips :focus-within and reveals both it and the panel. */}
        {editable && !editing && (
          <button
            type="button"
            className="ach-edit"
            aria-label={`Edit ${achievement.title}`}
            aria-describedby={descId}
            onClick={openEditor}
          >
            ✎
          </button>
        )}

        {editable && editing && (
          <div className="ach-editor">
            <label className="ach-editor-field">
              <span>Name</span>
              <input
                className="ach-editor-name"
                type="text"
                value={name}
                placeholder="Name"
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="ach-editor-field">
              <span>Description</span>
              <textarea
                className="ach-editor-desc"
                value={desc}
                rows={3}
                placeholder="Description"
                onChange={(e) => setDesc(e.target.value)}
              />
            </label>
            <label className="ach-editor-toggle">
              <input
                type="checkbox"
                checked={hide}
                onChange={(e) => setHide(e.target.checked)}
              />
              <span>Hide from collection</span>
            </label>
            <div className="ach-editor-actions">
              <button
                type="button"
                className="ach-editor-save"
                onClick={onSave}
                disabled={update.isPending}
              >
                Save
              </button>
              <button
                type="button"
                className="ach-editor-cancel"
                onClick={() => setEditing(false)}
                disabled={update.isPending}
              >
                Cancel
              </button>
            </div>
            {achievement.customized && (
              <button
                type="button"
                className="ach-editor-reset"
                onClick={onReset}
                disabled={update.isPending}
              >
                Reset to default
              </button>
            )}
          </div>
        )}

        {/* Rarity and locked-state are carried by a sheen and a weave — pure
            paint. This says the same thing to a screen reader. */}
        <span className="ach-sr">
          {rarity}
          {unlocked ? "" : ", locked"}
        </span>
      </div>
    </div>
  );
}
