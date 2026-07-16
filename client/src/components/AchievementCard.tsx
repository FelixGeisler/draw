import { achievementArt } from "../lib/achievementArt";
import { achievementRarity } from "../lib/achievementRarity";
import "./AchievementCard.css";

/** Exactly the achievement shape the /api/gamification payload delivers
 *  (useGamification.GamificationState) — this feature adds nothing to it. */
export interface AchievementCardData {
  key: string;
  title: string;
  emoji: string;
  description: string;
  unlockedAt: string | null;
}

/**
 * One collectible achievement card (issue #124) — the single card face, shared
 * by the Stats page collection and the unlock toast so a just-earned card and
 * the same card on the shelf are literally the same component.
 *
 * Speaks the #123 card language and nothing else (ADR-33): full-bleed art
 * under a legibility scrim, the name and — once earned — the date, plus the
 * rarity sheen. No ATK/DEF box, no type line, no level-star row; the rejected
 * TCG frame stays dead.
 *
 * Unlocked = face-up. Locked = face-DOWN: the app's own card-back weave (the
 * one .draw-face.front wears) with the art behind it as a darkened silhouette,
 * the name dimmed and the criteria kept as a readable hint. Deliberate
 * openness — an anti-procrastination tool shows its targets; the set has no
 * hidden-by-design achievements, so "???" would be mystery for its own sake.
 */
export function AchievementCard({
  achievement,
  className,
}: {
  achievement: AchievementCardData;
  className?: string;
}) {
  const rarity = achievementRarity(achievement.key);
  const art = achievementArt(achievement.key);
  const unlocked = achievement.unlockedAt != null;

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
            (ADR-33 e). */}
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
