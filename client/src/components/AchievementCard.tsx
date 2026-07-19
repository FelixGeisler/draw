import { achievementArt } from "../lib/achievementArt";
import { achievementRarity } from "../lib/achievementRarity";
import { celebrate } from "../lib/celebrate";
import { useClaimAchievement } from "../hooks/useGamification";
import { claimXpForKey } from "../../../shared/achievementTiers";
import "./AchievementCard.css";

/** Exactly the achievement shape the /api/gamification payload delivers
 *  (useGamification.GamificationState). */
export interface AchievementCardData {
  key: string;
  title: string;
  emoji: string;
  description: string;
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
 * claim-for-XP of #156) — the single card face, shared by the Stats page
 * collection and the unlock toast so a just-earned card and the same card on
 * the shelf are literally the same component.
 *
 * Speaks the #123 card language and nothing else (ADR-33): full-bleed art under
 * a legibility scrim, the name and — once earned — the date, plus the rarity
 * sheen. No ATK/DEF box, no type line, no level-star row; the rejected TCG
 * frame stays dead.
 *
 * Unlocked = face-up. Locked = face-DOWN: the app's own card-back weave with the
 * art behind it as a darkened silhouette, the name dimmed and the criteria kept
 * as a readable hint — plus, on a CHAIN card, a progress bar toward the next
 * threshold. An unlocked-but-unclaimed card shows a Claim affordance (only where
 * `claimable` is set — the transient toast never offers it).
 */
export function AchievementCard({
  achievement,
  className,
  claimable = false,
}: {
  achievement: AchievementCardData;
  className?: string;
  /** Render the Claim button on an unlocked+unclaimed card. Off in the toast. */
  claimable?: boolean;
}) {
  const rarity = achievementRarity(achievement.key);
  const art = achievementArt(achievement.key);
  const unlocked = achievement.unlockedAt != null;
  const claim = useClaimAchievement();

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

  return (
    <div
      // Common carries NO rarity class at all (the trophy pile's "none"
      // convention) — plain is the absence of a sheen, not a tier of one.
      className={[
        "ach-card",
        unlocked ? "unlocked" : "locked",
        rarity !== "common" ? `rarity-${rarity}` : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-key={achievement.key}
      data-rarity={rarity}
      // The criteria stay reachable on an earned card too, where the face
      // shows the date instead of the hint line.
      title={achievement.description}
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
          {unlocked ? (
            <div className="ach-date">unlocked {achievement.unlockedAt!.slice(0, 10)}</div>
          ) : (
            <div className="ach-hint">{achievement.description}</div>
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
