/**
 * Pure helpers for card surfaces (#123, formerly lib/cardFrame): the computed
 * contrast ink for the category pill (kept from #120) and the card-art
 * data/batch contracts (#27/#114). Everything here is render-time derivation
 * — no state, no DOM — so the legibility and mapping decisions are
 * unit-testable in isolation.
 */

/** Parse "#rgb" / "#rrggbb" to [0..255] channels; null for anything else. */
export function parseHexColor(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1];
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/** WCAG relative luminance of a hex color (0 = black, 1 = white). */
export function relativeLuminance(hex: string): number | null {
  const rgb = parseHexColor(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colors (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la == null || lb == null) return 1;
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** The two inks the category pill chooses between — near the app's darkest
 *  surface and its primary text, so the pill still reads as "this UI". */
export const DARK_INK = "#12141a";
export const LIGHT_INK = "#f5f7fb";

/**
 * Deterministic light/dark ink for text on a category-colored background
 * (#114, kept through the #123 redesign): compute both WCAG contrast ratios
 * and take the winner — never eyeballed, so pale category colors (e.g.
 * #ffb64f) get dark ink and dark ones get light ink, with a stable answer for
 * every hex in between. Malformed colors (hand-edited DB) fall back to light
 * ink on the assumption of the app's dark surfaces.
 */
export function pillInk(background: string): string {
  if (relativeLuminance(background) == null) return LIGHT_INK;
  return contrastRatio(background, DARK_INK) >= contrastRatio(background, LIGHT_INK)
    ? DARK_INK
    : LIGHT_INK;
}

/** Sanitized model SVG -> the one sanctioned rendering contract (#27):
 *  an <img> data URI, never dangerouslySetInnerHTML. */
export function svgDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Stable cache key / query string for the batch art read (#114): deduped
 * (recurring tasks can complete twice a day under one task id), sorted so
 * completion-order changes do not mint a second cache entry for the same set.
 */
export function batchArtKey(taskIds: number[]): string {
  return [...new Set(taskIds)].sort((a, b) => a - b).join(",");
}

/** Batch response -> per-card lookup for the pile's card faces (#114). */
export function artByTask(
  rows: { taskId: number; svg: string }[] | undefined,
): Map<number, string> {
  return new Map((rows ?? []).map((r) => [r.taskId, r.svg]));
}
