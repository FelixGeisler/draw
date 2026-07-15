import type { CSSProperties, ReactNode } from "react";
import type { Category } from "../api/types";
import { svgDataUri, typeLineInk } from "../lib/cardFrame";
import { ImpactStars } from "./TaskBadges";
import "./CardFrame.css";

/**
 * TCG card frame (#115) — the one component/CSS language for card surfaces.
 * Canonical attribute mapping (user-set, see the TCG design memory):
 *
 *   Level stars   = impact (1–5★), rendered ONLY when goal-linked (ADR-4)
 *   Monster Type  = category (the type-line pill, category-colored)
 *   ATK           = estimated minutes (absent estimate -> no ATK)
 *   DEF           = tracked minutes (grows as you fight the card, live)
 *   flavor text   = task description (small italics)
 *   rarity        = the #107 foil/silver sheens, composing ABOVE the frame
 *   art window    = generated art (#113), portrait, upper ~55% of the card
 *
 * Degraded grace is part of the contract: no art keeps the gradient
 * placeholder (the frame must look intentional without AI), no goal drops the
 * star row, no estimate drops ATK — a bare chore is still a proper card.
 *
 * The frame tint derives from the category color via the --cf-cat custom
 * property (color-mix in CSS) — no stored palette, no JS color math beyond
 * the type-line ink choice, which is a computed WCAG-contrast decision
 * (lib/cardFrame.ts), never an eyeballed one.
 *
 * Presentation only: interactive chrome (the #113 regenerate button) stays
 * OUTSIDE on .draw-scene — elements inside the backface-hidden 3D flip
 * context are not reliably hit-testable (Chromium).
 */

/** The category-colored type line — shared by the full frame, the trophy
 *  mini-frames and the focus overlay so "category" reads identically
 *  everywhere. Background is the raw category color; the ink is computed. */
export function TypeLine({ category, className }: { category: Category; className?: string }) {
  return (
    <span
      className={`cf-type-line ${className ?? ""}`}
      style={{ background: category.color, color: typeLineInk(category.color) }}
    >
      {category.name}
    </span>
  );
}

export function CardFrame({
  title,
  category,
  impact,
  goalLinked,
  artSvg,
  artKey,
  atk,
  def,
  flavor,
  children,
}: {
  title: string;
  category: Category | null;
  impact: number;
  /** Level stars render only for goal-linked tasks (ADR-4). */
  goalLinked: boolean;
  /** Sanitized model SVG; null/undefined -> gradient placeholder. */
  artSvg?: string | null;
  /** Remount key for the art fade-in — a regenerate replays it (#113). */
  artKey?: number | string;
  /** ATK = estimated minutes; null hides the stat (no estimate -> no ATK). */
  atk: number | null;
  /** DEF = tracked minutes; null hides the stat (payloads without the field). */
  def: number | null;
  flavor?: string | null;
  /** Page-specific extras (badges, warm-up note, hints, odds) — they render
   *  inside the text box, below the flavor text. */
  children?: ReactNode;
}) {
  return (
    <div
      className="card-frame"
      style={category ? ({ "--cf-cat": category.color } as CSSProperties) : undefined}
    >
      <div className="cf-name-bar">
        <h2 className="cf-title">{title}</h2>
      </div>
      <div className="cf-art">
        {/* Model-generated SVG renders exclusively as an <img> data URI
            (server-sanitized, too) — never dangerouslySetInnerHTML. The
            class names .draw-art/.draw-art-scrim are the #27 contract the
            degraded-mode E2E pins: neither renders without art. */}
        {artSvg && (
          <>
            <img key={artKey} className="draw-art" alt="" aria-hidden="true" src={svgDataUri(artSvg)} />
            <div className="draw-art-scrim" />
          </>
        )}
        {/* Yu-Gi-Oh-style level stars, overlaid on the art window's top edge
            so a missing star row never shifts the geometry below it. */}
        {goalLinked && (
          <span className="cf-stars">
            <ImpactStars value={impact} />
          </span>
        )}
      </div>
      {category && <TypeLine category={category} />}
      <div className="cf-body">
        {flavor && <p className="cf-flavor">{flavor}</p>}
        {children}
      </div>
      {(atk != null || def != null) && (
        <div className="cf-stats">
          {atk != null && (
            <span className="cf-atk" title="ATK — estimated minutes">
              ATK/{atk}
            </span>
          )}
          {def != null && (
            <span className="cf-def" title="DEF — minutes tracked so far">
              DEF/{def}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
