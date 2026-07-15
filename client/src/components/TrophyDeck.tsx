import { useEffect, useState, type CSSProperties } from "react";
import { useCardArtBatch } from "../hooks/useAi";
import { useGamification } from "../hooks/useGamification";
import { useCategories } from "../hooks/useTasks";
import { artByTask, svgDataUri } from "../lib/cardVisuals";
import { trophyRarity } from "../lib/trophyRarity";
import { CategoryPill } from "./TaskBadges";
import "./TrophyDeck.css";

export function TrophyDeck() {
  const { data } = useGamification();
  const categories = useCategories();
  // Tap/click lift (hover and keyboard focus are pure CSS): the id of the
  // card toggled up on touch devices, where hover does not exist.
  const [liftedId, setLiftedId] = useState<number | null>(null);
  const completions = data?.todayCompletions ?? [];

  // Card-face art (#114): ONE cache-only batch read for the whole pile —
  // never the per-task GET, which generates on a miss. Completions without
  // cached art keep the gradient face silently.
  const batchArt = useCardArtBatch(completions.map((c) => c.taskId));
  const art = artByTask(batchArt.data?.arts);

  // Tapping anywhere outside a card lowers the lifted one. Taps ON a card are
  // excluded here — the card's own onClick handles toggle/switch, and clearing
  // on pointerdown first would turn a toggle-off click back into a lift.
  useEffect(() => {
    if (liftedId === null) return;
    const lower = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest(".trophy-card")) return;
      setLiftedId(null);
    };
    document.addEventListener("pointerdown", lower);
    return () => document.removeEventListener("pointerdown", lower);
  }, [liftedId]);

  if (completions.length === 0) return null;

  return (
    <div className="trophy-deck">
      <h3>
        Today's pile — {completions.length} done ·{" "}
        {completions.reduce((a, c) => a + c.xpAwarded, 0)} XP
      </h3>
      <div className="trophy-pile">
        {completions.map((c, i) => {
          const category = categories.data?.find((cat) => cat.id === c.categoryId);
          const time = new Date(c.completedAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          });
          const lifted = liftedId === c.id;
          const toggle = () => setLiftedId((prev) => (prev === c.id ? null : c.id));
          // Deterministic rarity (issue #62), computed from the completion's
          // own facts at render time — never stored (ADR-2/ADR-5 spirit).
          const rarity = trophyRarity(c);
          const cardArt = art.get(c.taskId);
          return (
            <div
              key={c.id}
              role="button"
              tabIndex={0}
              aria-pressed={lifted}
              aria-label={[
                c.title,
                category?.name,
                `completed ${time}`,
                `+${c.xpAwarded} XP${c.wasDrawn ? " (drawn)" : ""}`,
                rarity !== "none" ? rarity : null,
              ]
                .filter(Boolean)
                .join(", ")}
              className={`trophy-card ${lifted ? "lifted" : ""}${
                rarity !== "none" ? ` rarity-${rarity}` : ""
              }`}
              // The per-card rotation is data-driven, so it flows in as a CSS
              // custom property — an inline `transform` would out-specificity
              // the CSS lift states.
              style={
                {
                  "--trophy-rot": `${(i % 5) * 2 - 4}deg`,
                  "--cat-color": category?.color,
                } as CSSProperties
              }
              onClick={toggle}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggle();
                } else if (e.key === "Escape") {
                  setLiftedId(null);
                  e.currentTarget.blur(); // drops the :focus-visible lift too
                }
              }}
            >
              <div className="trophy-card-inner">
                {/* Full-bleed face (#123): cached art (or the gradient)
                    UNDER the scrim and text, all under the rarity sheen
                    (the inner's ::after). Absolutely positioned layers only —
                    the #47 lift invariant (transform + z-index, no box
                    change) holds. Model SVG renders as an <img> data URI,
                    never dangerouslySetInnerHTML. */}
                {cardArt && (
                  <>
                    <img
                      className="trophy-art"
                      alt=""
                      aria-hidden="true"
                      src={svgDataUri(cardArt)}
                    />
                    <div className="trophy-art-scrim" />
                  </>
                )}
                <div className="trophy-card-glyph">{c.wasDrawn ? "🃏" : "✅"}</div>
                <div className="trophy-card-title">{c.title}</div>
                <div className="trophy-details">
                  {category && <CategoryPill category={category} />}
                </div>
                {/* Footer: completion time + XP, readable in the collapsed
                    pile too (#114) — not lift-gated like the details. */}
                <div className="trophy-footer">
                  <span className="trophy-time">{time}</span>
                  <span className="trophy-card-xp">+{c.xpAwarded}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
