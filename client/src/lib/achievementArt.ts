/**
 * Achievement card art (issue #124, extended for the #156 chains in #163):
 * one hand-designed SVG committed to the repo per achievement key, each
 * building on that achievement's motif — 🃏 the card leaving the deck (and
 * the deeper draw tiers fanning into a vortex), ✅ the decisive check (tallies
 * mounting into a monument), 🔥 the streak flame rising to an inferno, ⭐ the
 * risen star growing to a galaxy, 🏆 bronze→silver→gold trophies for goals,
 * ⏳ hourglasses for tracked hours. Static imports, so Vite bundles them
 * (fingerprinted assets, or inlined as data URIs when small) and the browser
 * caches them — no network dependency, no key required.
 *
 * Deliberately NOT the AI card-art pipeline (#27/#113/#114): that cache is
 * task-keyed, so achievements would need their own storage plus a degraded
 * no-key fallback — new schema and an AI dependency for a FIXED set that never
 * grows at runtime. Committed art is always present, deterministic for E2E
 * (the suite always runs AI-degraded), and lets each card be designed on
 * purpose. The chain tiers escalate the motif so a chain reads as a rising set.
 *
 * The art carries no text — the card face renders the name and date as real
 * DOM, so it stays translatable, selectable and screen-reader-visible.
 */

// Original set (#124).
import deckClearer from "../assets/achievements/deck_clearer.svg";
import earlyBird from "../assets/achievements/early_bird.svg";
import firstCompletion from "../assets/achievements/first_completion.svg";
import firstDraw from "../assets/achievements/first_draw.svg";
import level10 from "../assets/achievements/level_10.svg";
import level5 from "../assets/achievements/level_5.svg";
import monsterSlayer from "../assets/achievements/monster_slayer.svg";
import streak30 from "../assets/achievements/streak_30.svg";
import streak7 from "../assets/achievements/streak_7.svg";

// Chain tiers + first_goal (#156/#163).
import draw10 from "../assets/achievements/draw_10.svg";
import draw100 from "../assets/achievements/draw_100.svg";
import draw1000 from "../assets/achievements/draw_1000.svg";
import draw10000 from "../assets/achievements/draw_10000.svg";
import complete25 from "../assets/achievements/complete_25.svg";
import complete100 from "../assets/achievements/complete_100.svg";
import complete500 from "../assets/achievements/complete_500.svg";
import complete2500 from "../assets/achievements/complete_2500.svg";
import streak100 from "../assets/achievements/streak_100.svg";
import level25 from "../assets/achievements/level_25.svg";
import level50 from "../assets/achievements/level_50.svg";
import firstGoal from "../assets/achievements/first_goal.svg";
import goals5 from "../assets/achievements/goals_5.svg";
import goals25 from "../assets/achievements/goals_25.svg";
import hours10 from "../assets/achievements/hours_10.svg";
import hours100 from "../assets/achievements/hours_100.svg";
import hours1000 from "../assets/achievements/hours_1000.svg";
import drawn10 from "../assets/achievements/drawn_10.svg";
import drawn100 from "../assets/achievements/drawn_100.svg";
import drawn1000 from "../assets/achievements/drawn_1000.svg";
import steps10 from "../assets/achievements/steps_10.svg";
import steps100 from "../assets/achievements/steps_100.svg";
import steps500 from "../assets/achievements/steps_500.svg";
import holoHunter from "../assets/achievements/holo_hunter.svg";
import momentumArt from "../assets/achievements/momentum.svg";
import wellRounded from "../assets/achievements/well_rounded.svg";
import nightShift from "../assets/achievements/night_shift.svg";
import comebackArt from "../assets/achievements/comeback.svg";

const ART: Record<string, string> = {
  deck_clearer: deckClearer,
  early_bird: earlyBird,
  first_completion: firstCompletion,
  first_draw: firstDraw,
  level_10: level10,
  level_5: level5,
  monster_slayer: monsterSlayer,
  streak_30: streak30,
  streak_7: streak7,
  draw_10: draw10,
  draw_100: draw100,
  draw_1000: draw1000,
  draw_10000: draw10000,
  complete_25: complete25,
  complete_100: complete100,
  complete_500: complete500,
  complete_2500: complete2500,
  streak_100: streak100,
  level_25: level25,
  level_50: level50,
  first_goal: firstGoal,
  goals_5: goals5,
  goals_25: goals25,
  hours_10: hours10,
  hours_100: hours100,
  hours_1000: hours1000,
  drawn_10: drawn10,
  drawn_100: drawn100,
  drawn_1000: drawn1000,
  steps_10: steps10,
  steps_100: steps100,
  steps_500: steps500,
  holo_hunter: holoHunter,
  momentum: momentumArt,
  well_rounded: wellRounded,
  night_shift: nightShift,
  comeback: comebackArt,
};

/** Undefined for an unknown key — the card falls back to its gradient face
 *  and the achievement's emoji, the same degraded grace the task cards give
 *  a completion without cached art (ADR-33 e). Every shipped key has art. */
export function achievementArt(key: string): string | undefined {
  return ART[key];
}
