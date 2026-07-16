/**
 * Achievement card art (issue #124): ten hand-designed SVGs committed to the
 * repo, one per achievement key, each building on that achievement's emoji as
 * its motif (🃏 the card leaving the deck, 🐉 the slain dragon, 🏜 the emptied
 * deck in the sand…). Static imports, so Vite fingerprints them into the
 * bundle and the browser caches them — no data URIs, no network dependency,
 * no key required.
 *
 * Deliberately NOT the AI card-art pipeline (#27/#113/#114): that cache is
 * task-keyed, so achievements would need their own storage plus a degraded
 * no-key fallback — new schema and an AI dependency for a FIXED set of ten
 * that never grows at runtime. Committed art is always present, deterministic
 * for E2E (the suite always runs AI-degraded), and lets each card be designed
 * on purpose. Revisit if the set ever grows.
 *
 * The art carries no text — the card face renders the name and date as real
 * DOM, so it stays translatable, selectable and screen-reader-visible.
 */
import deckClearer from "../assets/achievements/deck_clearer.svg";
import earlyBird from "../assets/achievements/early_bird.svg";
import firstCompletion from "../assets/achievements/first_completion.svg";
import firstDraw from "../assets/achievements/first_draw.svg";
import level10 from "../assets/achievements/level_10.svg";
import level5 from "../assets/achievements/level_5.svg";
import leverageMaster from "../assets/achievements/leverage_master.svg";
import monsterSlayer from "../assets/achievements/monster_slayer.svg";
import streak30 from "../assets/achievements/streak_30.svg";
import streak7 from "../assets/achievements/streak_7.svg";

const ART: Record<string, string> = {
  deck_clearer: deckClearer,
  early_bird: earlyBird,
  first_completion: firstCompletion,
  first_draw: firstDraw,
  level_10: level10,
  level_5: level5,
  leverage_master: leverageMaster,
  monster_slayer: monsterSlayer,
  streak_30: streak30,
  streak_7: streak7,
};

/** Undefined for an unknown key — the card falls back to its gradient face
 *  and the achievement's emoji, the same degraded grace the task cards give
 *  a completion without cached art (ADR-33 e). */
export function achievementArt(key: string): string | undefined {
  return ART[key];
}
