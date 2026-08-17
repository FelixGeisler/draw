import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Token-layer gate (#244): the five migrated stylesheets keep NO bare
 * duration or radius literals inside rules. Shared structural values use the
 * shared `--dur-*` / `--radius-*` tokens from index.css; genuinely bespoke
 * timings (holo drift, sheen sweep, …) become NAMED file-local custom
 * properties declared at the top of their file — which is exactly the escape
 * hatch this gate honours: a `--foo: 3.5s` DECLARATION is fine, a
 * `animation: sheen 3.5s` USE is not.
 *
 * Test-first (#244): these are `it.fails` until the migration lands — the
 * implementer flips each to plain `it` as its file goes clean (an
 * "unexpected pass" under vitest is the reminder).
 *
 * Scans, per declaration:
 *   - `transition*` / `animation*` values for non-zero `<n>s` / `<n>ms`
 *   - `border*radius` values for non-zero `<n>px`
 * Exempt by construction: custom-property declarations (property starts with
 * `--`), `var()` uses, `0s`/`0ms`/`0`/`0px`, percentages (`50%`),
 * `inherit`, and keywords (`ease`, `linear`, `infinite`, …).
 */

const FILES: Record<string, string> = {
  "index.css": "./index.css",
  "AchievementCard.css": "./components/AchievementCard.css",
  "GoalShelf.css": "./components/GoalShelf.css",
  "DrawPage.css": "./pages/DrawPage.css",
  "HistoryCalendar.css": "./components/HistoryCalendar.css",
};

export function bareLiteralViolations(css: string): string[] {
  const out: string[] = [];
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  // One declaration at a time: `prop: value` delimited by ; { }. Custom
  // properties start with `--` and fail the first character class, so the
  // named-property escape hatch needs no special casing. Media-query
  // conditions like `(hover: none)` are preceded by `(`, not `;`/`{`, and
  // never match either.
  const decl = /(?:^|[;{}])\s*([a-zA-Z][a-zA-Z-]*)\s*:\s*([^;{}]*)/g;
  for (const m of src.matchAll(decl)) {
    const prop = m[1].toLowerCase();
    const value = m[2].trim();
    if (/^(?:-webkit-)?(?:transition|animation)/.test(prop)) {
      for (const t of value.matchAll(/(?<![\w.%$#-])(\d*\.?\d+)(m?s)\b/g)) {
        if (parseFloat(t[1]) !== 0) out.push(`${prop}: ${value}  ← bare ${t[0]}`);
      }
    }
    if (/^border[a-z-]*radius$/.test(prop)) {
      for (const t of value.matchAll(/(\d*\.?\d+)px/g)) {
        if (parseFloat(t[1]) !== 0) {
          out.push(`${prop}: ${value}  ← bare ${t[0]}`);
          break; // one report per declaration is enough
        }
      }
    }
  }
  return out;
}

describe("#244 token gate — no bare duration/radius literals in migrated stylesheets", () => {
  for (const [name, rel] of Object.entries(FILES)) {
    it.fails(`${name} uses tokens or named file-local properties`, () => {
      const css = readFileSync(new URL(rel, import.meta.url), "utf8");
      expect(bareLiteralViolations(css)).toEqual([]);
    });
  }
});
