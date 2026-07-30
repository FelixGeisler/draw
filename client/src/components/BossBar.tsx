import type { BossBarState } from "../lib/bossBar";
import "./BossBar.css";

/**
 * The boss HP bar (#229): a goal's remaining work as an opponent. Replaces
 * the plain count-progress bar WHEN the goal has estimated leaves (bossBar()
 * returned a state); the count bar stays the fallback for unestimated goals.
 *
 * Enrage is the feasibility chip's `infeasible` verdict wearing war paint —
 * the pulse animates only under no-preference (the #62/#123 pattern); the
 * red end-state itself applies either way. All numbers are spoken as text:
 * the bar is presentation, the caption is the fact.
 */
export function BossBar({ bar }: { bar: BossBarState }) {
  return (
    <div
      className={`boss-bar ${bar.enraged ? "enraged" : ""} ${bar.hp === 0 ? "downed" : ""}`}
      data-testid="boss-bar"
    >
      <div
        className="boss-bar-track"
        role="progressbar"
        aria-label={bar.enraged ? "Boss HP — enraged" : "Boss HP"}
        aria-valuenow={bar.hp}
        aria-valuemin={0}
        aria-valuemax={bar.maxHp}
      >
        <div className="boss-bar-fill" style={{ width: `${bar.pct * 100}%` }} />
      </div>
      <span className="boss-bar-caption">
        {bar.hp === 0 ? (
          <>⚔ downed — {bar.damage} dmg dealt</>
        ) : (
          <>
            ♥ {bar.hp}/{bar.maxHp}
            {bar.damage > 0 && <span className="boss-bar-dmg"> · {bar.damage} dmg</span>}
            {bar.enraged && <span className="boss-bar-rage"> · enraged</span>}
          </>
        )}
      </span>
    </div>
  );
}
