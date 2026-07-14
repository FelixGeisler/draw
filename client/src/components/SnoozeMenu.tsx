import { SNOOZE_PRESETS, wakeDateFromInput } from "../lib/snooze";

interface Props {
  /** Called with the wake timestamp as a UTC ISO string. */
  onSnooze: (untilIso: string) => void;
  /** Take the task out of the deck until it is explicitly woken. */
  onBlock: () => void;
}

/**
 * The shared "Not now" preset row (issue #19) — used on the drawn card and on
 * task rows. Purely presentational; the caller performs the PATCH.
 */
export function SnoozeMenu({ onSnooze, onBlock }: Props) {
  return (
    <div
      style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "center" }}
    >
      {SNOOZE_PRESETS.map((p) => (
        <button key={p.key} onClick={() => onSnooze(p.until(new Date()).toISOString())}>
          {p.label}
        </button>
      ))}
      <input
        type="date"
        title="Snooze until date"
        style={{ padding: "4px 6px" }}
        onChange={(e) => {
          if (e.target.value) onSnooze(wakeDateFromInput(e.target.value).toISOString());
        }}
      />
      <button onClick={onBlock} title="Out of the deck until you wake it">
        ⛔ Block indefinitely
      </button>
    </div>
  );
}
