/**
 * Deterministic style directives for the card art (#113, amends ADR-22).
 *
 * Every card used to converge on one look: a single system-prompt recipe with
 * the category color as "the single accent" left the model nothing to vary.
 * This module derives a style — archetype, palette harmony, density, focal
 * placement — as a pure function of the task id, so:
 *   - the same task ALWAYS gets the same directives (the at-most-once cache
 *     in cardArtService stays coherent, and a regenerate keeps the task's
 *     visual identity while re-rolling the model's execution of it);
 *   - different tasks spread across genuinely different recipes.
 *
 * Directive vocabulary is bounded by the sanitizer's allowlist
 * (svgSanitizer.ts): shapes/paths, linear/radial gradients, patterns,
 * clipPath/mask, <use>, and the full fe* filter set. Directives never ask for
 * <text>, <style>, <image>, animation, or external references.
 *
 * Pure module: no DB, no HTTP, no SDK — unit-testable in isolation.
 */

export interface StyleDirective {
  name: string;
  directive: string;
}

// Each archetype is a distinct visual grammar, not a theme: it prescribes the
// construction technique (which the model is bad at inventing unprompted) and
// leaves the task's theme to steer the specifics.
export const ARCHETYPES: readonly StyleDirective[] = [
  {
    name: "layered geometric",
    directive:
      "Build the scene from overlapping translucent polygons and rotated rectangles stacked in 3-5 depth layers. Edges stay crisp; depth comes from opacity steps, and a clipPath may slice the topmost layer. No curves — everything straight-edged and angular.",
  },
  {
    name: "organic curves",
    directive:
      "Build the scene from flowing cubic Bezier ribbons — wide, layered wave bands that swell and taper as they cross the canvas. Give each band a soft linear gradient along its sweep and let a mask fade the outermost band into the base. No straight lines anywhere.",
  },
  {
    name: "constellation",
    directive:
      "Build the scene as a night-field of small dots: define one circle in <defs> and place it with <use> at varied positions and scales, joining some dots with hairline lines into 2-3 loose clusters with deliberate empty voids between them. A faint blurred halo behind the brightest dots suggests glow.",
  },
  {
    name: "gradient mesh",
    directive:
      "Build the scene from 4-6 large overlapping radial gradients — soft color fields that melt into each other like out-of-focus lights. No outlines, no hard edges: every shape is an ellipse or circle softened by a generous feGaussianBlur and layered at low opacity.",
  },
  {
    name: "brush strokes",
    directive:
      "Build the scene from a few broad, confident painterly strokes: thick tapered paths whose edges are roughened by a filter chain of feTurbulence fed into feDisplacementMap. Vary stroke width and opacity so the pigment seems to thin mid-stroke, and leave visible base between strokes.",
  },
  {
    name: "prismatic shards",
    directive:
      "Build the scene as fractured glass: an irregular field of adjoining triangles and sharp quadrilaterals, each facet filled with its own subtle gradient, one or two facets glinting brighter as if catching light. Hairline gaps of the dark base show between facets like leading in a window.",
  },
  {
    name: "contour lines",
    directive:
      "Build the scene as a topographic map of imaginary terrain: nested closed paths as thin, slightly wavering concentric rings around 1-2 peaks, stroked with no fill. Ring spacing tightens near each peak, and a radial-gradient mask fades the outermost rings into the base.",
  },
];

// Harmony replaces the old "single accent" rule: the category color still
// anchors the card to its category, but companion tones give the model a real
// palette. Every line repeats the legibility constraint because it is the one
// rule the art must never trade away (the scrim assumes a dark backdrop).
export const HARMONIES: readonly { name: string; line: (color: string) => string }[] = [
  {
    name: "analogous",
    line: (color) =>
      `Palette harmony — analogous: build the palette from the category color ${color} plus two or three companion tones within roughly 30 degrees of its hue, all muted in saturation and low-to-mid in lightness so the artwork stays quietly behind the text.`,
  },
  {
    name: "complementary",
    line: (color) =>
      `Palette harmony — complementary: the category color ${color} leads, answered sparingly by its opposite hue as a restrained counterpoint (at most about a fifth of the colored area), both desaturated and dark enough to sit behind the text.`,
  },
  {
    name: "split-complementary",
    line: (color) =>
      `Palette harmony — split-complementary: the category color ${color} leads, supported by two subdued tones flanking its complement; keep all three low-saturation and dark so no area competes with the text above.`,
  },
];

export const DENSITIES: readonly StyleDirective[] = [
  {
    name: "sparse",
    directive:
      "Density: sparse — a few deliberate elements and generous negative space; let the dark base breathe.",
  },
  {
    name: "medium",
    directive:
      "Density: medium — a balanced arrangement with clear focal elements and calm supporting areas.",
  },
  {
    name: "dense",
    directive:
      "Density: dense — an intricate, closely worked field that still reads calm: repetition stays subtle and low-contrast.",
  },
];

// All placements bias the interest upward: the TCG frame (#115) will present
// this art through a portrait art window that favors the upper-center.
export const FOCALS: readonly StyleDirective[] = [
  {
    name: "upper-center",
    directive:
      "Focal placement: concentrate the visual interest in the upper-center of the canvas, easing off toward the bottom.",
  },
  {
    name: "upper-third band",
    directive:
      "Focal placement: run the strongest activity as a band across the upper third, with quiet space above and below.",
  },
  {
    name: "high off-corner",
    directive:
      "Focal placement: anchor the composition high in one upper corner and let it dissolve diagonally toward the opposite lower edge.",
  },
  {
    name: "rising diagonal",
    directive:
      "Focal placement: sweep the composition along a rising diagonal that culminates in the upper-center area.",
  },
];

// FNV-1a over "<id>:<salt>" — stable across runs, platforms and Node versions
// (Math.imul pins the 32-bit overflow), and it decorrelates consecutive task
// ids far better than modulo on the raw id. One salt per style axis keeps the
// axes independent: neighboring ids differ in more than just the archetype.
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function pick<T>(list: readonly T[], taskId: number, salt: string): T {
  return list[fnv1a(`${taskId}:${salt}`) % list.length];
}

export interface CardArtStyle {
  archetype: StyleDirective;
  harmony: { name: string; line: (color: string) => string };
  density: StyleDirective;
  focal: StyleDirective;
}

/** Pure: the same task id always yields the same style on every call. */
export function selectCardArtStyle(taskId: number): CardArtStyle {
  return {
    archetype: pick(ARCHETYPES, taskId, "archetype"),
    harmony: pick(HARMONIES, taskId, "harmony"),
    density: pick(DENSITIES, taskId, "density"),
    focal: pick(FOCALS, taskId, "focal"),
  };
}

export interface CardArtPromptInput {
  taskId: number;
  title: string;
  category: string;
  color: string;
  goalTitle?: string | null;
}

/**
 * The complete user prompt for one card-art generation. Exported pure so the
 * built prompt is verifiable without any API call (and without a DB):
 * cardArtContext() in aiService only adds the row lookup on top of this.
 */
export function buildCardArtPrompt(input: CardArtPromptInput): string {
  const style = selectCardArtStyle(input.taskId);
  return [
    `Create the card-back artwork for this drawn task.`,
    ``,
    `Task: ${input.title}`,
    `Category: ${input.category} (category color: ${input.color})`,
    input.goalTitle ? `Part of goal: ${input.goalTitle}` : "",
    ``,
    `Style archetype — ${style.archetype.name}: ${style.archetype.directive}`,
    style.harmony.line(input.color),
    style.density.directive,
    style.focal.directive,
    ``,
    `Return the complete SVG markup in the svg field.`,
  ]
    .filter(Boolean)
    .join("\n");
}
