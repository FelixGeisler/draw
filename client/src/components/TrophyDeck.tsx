import { useEffect, useState, type CSSProperties } from "react";
import { useGamification } from "../hooks/useGamification";
import { useCategories } from "../hooks/useTasks";
import { trophyRarity } from "../lib/trophyRarity";
import "./TrophyDeck.css";

export function TrophyDeck() {
  const { data } = useGamification();
  const categories = useCategories();
  // Tap/click lift (hover and keyboard focus are pure CSS): the id of the
  // card toggled up on touch devices, where hover does not exist.
  const [liftedId, setLiftedId] = useState<number | null>(null);
  const completions = data?.todayCompletions ?? [];

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
              style={{ "--trophy-rot": `${(i % 5) * 2 - 4}deg` } as CSSProperties}
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
                <div className="trophy-card-glyph">{c.wasDrawn ? "🃏" : "✅"}</div>
                <div className="trophy-card-title">{c.title}</div>
                <div className="trophy-details">
                  {category && (
                    <div>
                      <span className="dot" style={{ background: category.color }} />{" "}
                      {category.name}
                    </div>
                  )}
                  <div>done {time}</div>
                </div>
                <div className="trophy-card-xp">+{c.xpAwarded}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
