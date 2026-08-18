import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrastRatio, parseHexColor } from "./lib/cardVisuals";

/**
 * Contrast gate (#255) — sibling of the #244 token gate (designTokens.test.ts).
 *
 * The card-table reskin retunes the :root color tokens (charcoal-and-blue →
 * felt-and-brass). This gate makes legibility a PERMANENT invariant of the
 * token layer, not a property of any particular palette: it parses the actual
 * token values out of index.css and computes WCAG contrast ratios, so the felt
 * can never quietly go illegible — today's palette and every future retune
 * must clear the same bars.
 *
 *   --text     on --bg        ≥ 7:1   (AAA body text)
 *   --text     on --bg-panel  ≥ 7:1
 *   --text-dim on --bg        ≥ 4.5:1 (AA)
 *   --text-dim on --bg-panel  ≥ 4.5:1
 *   primary-button ink on --accent ≥ 4.5:1 (AA)
 *
 * The math is lib/cardVisuals' own WCAG helpers — the same luminance/contrast
 * code that picks the category pill ink — so the gate and the product can
 * never disagree about what "contrast" means.
 *
 * Spec-first history (#255): the primary-button check started as `it.fails`
 * against the blue chrome — white on #4f8cff was 3.22:1, exactly the debt
 * the brass retune paid (dark --accent-ink on brass computes ≥ 7:1).
 */

const css = readFileSync(new URL("./index.css", import.meta.url), "utf8");

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");

/** All `--name: value` declarations of the first `:root` block. Values can
 *  span lines (the sheen gradients do) but never contain `;` or `}`. */
export function rootTokens(source: string): Map<string, string> {
  const m = /:root\s*\{([^}]*)\}/.exec(stripComments(source));
  if (!m) return new Map();
  const tokens = new Map<string, string>();
  for (const d of m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) {
    tokens.set(d[1], d[2].trim());
  }
  return tokens;
}

/**
 * Resolve a token value to a hex color literal, following `var(--x)`
 * indirection (new identity tokens may alias existing ones) with a fallback
 * arm and a cycle guard. Returns null for anything that is not, in the end,
 * a `#rgb`/`#rrggbb` literal — the gate then fails loudly rather than
 * skipping a token it cannot read.
 */
export function resolveTokenColor(
  tokens: Map<string, string>,
  value: string,
  depth = 0,
): string | null {
  if (depth > 4) return null;
  const v = value.trim();
  const ref = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(v);
  if (ref) {
    const target = tokens.get(ref[1]);
    if (target != null) return resolveTokenColor(tokens, target, depth + 1);
    return ref[2] != null ? resolveTokenColor(tokens, ref[2], depth + 1) : null;
  }
  return parseHexColor(v) ? v : null;
}

/** The `color` of the `button.primary` rule (last declaration wins), because
 *  the primary-button ink is not a token today (`color: #fff` inline). If the
 *  retune promotes it to a token, a `var(--…)` value resolves via :root. */
export function primaryButtonInk(source: string): string | null {
  const m = /(?:^|\})\s*button\.primary\s*\{([^}]*)\}/.exec(stripComments(source));
  if (!m) return null;
  let ink: string | null = null;
  for (const d of m[1].matchAll(/(?:^|;)\s*color\s*:\s*([^;]+)/g)) {
    ink = d[1].trim();
  }
  return ink;
}

const GATED = ["--bg", "--bg-panel", "--text", "--text-dim", "--accent"] as const;

function color(tokens: Map<string, string>, name: string): string {
  const raw = tokens.get(name);
  expect(raw, `${name} is declared in :root`).toBeDefined();
  const hex = resolveTokenColor(tokens, raw!);
  expect(hex, `${name}: "${raw}" must resolve to a hex color literal`).not.toBeNull();
  return hex!;
}

function gate(fg: string, bg: string, min: number, label: string) {
  const ratio = contrastRatio(fg, bg);
  expect(
    ratio,
    `${label}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1 — the gate is ≥ ${min}:1`,
  ).toBeGreaterThanOrEqual(min);
}

describe("contrast math — canonical WCAG anchors for the gate's own helpers", () => {
  it("black on white is 21:1 and the ratio is symmetric", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
  });
});

describe("#255 contrast gate — the palette may retune, legibility may not", () => {
  const tokens = rootTokens(css);

  it("every gated token exists in :root and resolves to a parseable color", () => {
    for (const name of GATED) color(tokens, name);
  });

  it("--text on --bg ≥ 7:1 (AAA)", () => {
    gate(color(tokens, "--text"), color(tokens, "--bg"), 7, "--text/--bg");
  });

  it("--text on --bg-panel ≥ 7:1 (AAA)", () => {
    gate(color(tokens, "--text"), color(tokens, "--bg-panel"), 7, "--text/--bg-panel");
  });

  it("--text-dim on --bg ≥ 4.5:1 (AA)", () => {
    gate(color(tokens, "--text-dim"), color(tokens, "--bg"), 4.5, "--text-dim/--bg");
  });

  it("--text-dim on --bg-panel ≥ 4.5:1 (AA)", () => {
    gate(color(tokens, "--text-dim"), color(tokens, "--bg-panel"), 4.5, "--text-dim/--bg-panel");
  });

  // The blue chrome's standing AA failure (white on #4f8cff = 3.22:1), paid
  // by #255: primary-button ink is DARK on brass — never white on brass.
  it("primary-button ink on --accent ≥ 4.5:1 (AA)", () => {
    const ink = primaryButtonInk(css);
    expect(ink, "button.primary declares a color (its ink)").not.toBeNull();
    const inkHex = resolveTokenColor(tokens, ink!);
    expect(inkHex, `button.primary ink "${ink}" resolves to a hex color`).not.toBeNull();
    gate(inkHex!, color(tokens, "--accent"), 4.5, "primary ink/--accent");
  });
});
