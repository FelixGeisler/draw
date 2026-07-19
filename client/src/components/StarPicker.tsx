// The one impact-rating control (1–5★), shared by every surface that lets the
// user set impact: the TaskForm (quick capture / row edit / drawn-card edit)
// and the AI review panels (#161 — impact is a field the model guesses, so the
// review-before-accept contract of ADR-14 demands it be correctable). Each star
// is a role="button" with an accessible name so a specific rating is
// addressable in tests; the container title stays "Impact toward the goal
// (1–5)" by default, which the drawn-card edit spec keys on.
//
// Keyboard operability (#161 review): a role="button" that only responds to
// clicks lies to assistive tech — it announces an interactive control that
// keyboard users cannot reach or fire. Each star is therefore focusable
// (tabIndex 0) and activates on Enter/Space, and aria-pressed reports whether
// it is currently filled so a screen reader conveys the standing rating.
export function StarPicker({
  value,
  onChange,
  size = 18,
  title = "Impact toward the goal (1–5)",
}: {
  value: number;
  onChange: (v: number) => void;
  /** Font size of the stars in px — smaller in the dense review rows. */
  size?: number;
  title?: string;
}) {
  return (
    <span title={title} style={{ fontSize: size, cursor: "pointer", whiteSpace: "nowrap" }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          role="button"
          tabIndex={0}
          aria-label={`Set impact ${n}`}
          aria-pressed={n <= value}
          onClick={() => onChange(n)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onChange(n);
            }
          }}
          style={{ color: n <= value ? "var(--warn)" : "var(--border)" }}
        >
          ★
        </span>
      ))}
    </span>
  );
}
