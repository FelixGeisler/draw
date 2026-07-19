// The one impact-rating control (1–5★), shared by every surface that lets the
// user set impact: the TaskForm (quick capture / row edit / drawn-card edit)
// and the AI review panels (#161 — impact is a field the model guesses, so the
// review-before-accept contract of ADR-14 demands it be correctable). Each star
// is a role="button" with an accessible name so a specific rating is
// addressable in tests; the container title stays "Impact toward the goal
// (1–5)" by default, which the drawn-card edit spec keys on.
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
          aria-label={`Set impact ${n}`}
          onClick={() => onChange(n)}
          style={{ color: n <= value ? "var(--warn)" : "var(--border)" }}
        >
          ★
        </span>
      ))}
    </span>
  );
}
