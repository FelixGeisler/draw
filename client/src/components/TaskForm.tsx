import { useState } from "react";
import type { Category, Goal, NewTask, Task } from "../api/types";
import { resolveSubmittedImpact } from "../lib/impact";

interface Props {
  categories: Category[];
  goals?: Goal[];
  initial?: Partial<Task>;
  autoFocus?: boolean;
  submitLabel?: string;
  onSubmit: (task: NewTask) => void | Promise<unknown>;
  onCancel?: () => void;
}

// Availability editor (#33): rendered Mon-first, stored as getDay() numbers.
const WEEKDAYS: { day: number; label: string }[] = [
  { day: 1, label: "Mon" },
  { day: 2, label: "Tue" },
  { day: 3, label: "Wed" },
  { day: 4, label: "Thu" },
  { day: 5, label: "Fri" },
  { day: 6, label: "Sat" },
  { day: 0, label: "Sun" },
];

function StarPicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <span title="Impact toward the goal (1–5)" style={{ fontSize: 18, cursor: "pointer" }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          onClick={() => onChange(n)}
          style={{ color: n <= value ? "var(--warn)" : "var(--border)" }}
        >
          ★
        </span>
      ))}
    </span>
  );
}

export function TaskForm({ categories, goals, initial, autoFocus, submitLabel, onSubmit, onCancel }: Props) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [categoryId, setCategoryId] = useState<number>(initial?.categoryId ?? categories[0]?.id ?? 1);
  const [goalId, setGoalId] = useState<number | "">(initial?.goalId ?? "");
  const [impact, setImpact] = useState<number>(initial?.impact ?? 3);
  const [effort, setEffort] = useState<string>(initial?.effortMinutes?.toString() ?? "");
  const [dueDate, setDueDate] = useState<string>(initial?.dueDate ?? "");
  const [recur, setRecur] = useState<string>(initial?.recurEveryDays?.toString() ?? "");
  // Availability window (#33) — tucked behind a toggle so quick capture stays
  // lean. Enabling seeds a sensible Mon–Fri office window to edit from.
  const [windowOpen, setWindowOpen] = useState(initial?.windowDays != null);
  const [windowDays, setWindowDays] = useState<number[]>(initial?.windowDays ?? [1, 2, 3, 4, 5]);
  const [windowStart, setWindowStart] = useState(initial?.windowStart ?? "09:00");
  const [windowEnd, setWindowEnd] = useState(initial?.windowEnd ?? "17:00");

  // All-or-none (server-validated): an editor left incomplete submits no
  // window at all — identical to toggling it off.
  const windowSet =
    windowOpen && windowDays.length > 0 && windowStart !== "" && windowEnd !== "";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    await onSubmit({
      title: title.trim(),
      categoryId,
      goalId: goalId === "" ? null : goalId,
      impact: resolveSubmittedImpact(goalId, impact, initial),
      effortMinutes: effort ? Number(effort) : null,
      dueDate: dueDate || null,
      recurEveryDays: recur ? Number(recur) : null,
      windowDays: windowSet ? windowDays : null,
      windowStart: windowSet ? windowStart : null,
      windowEnd: windowSet ? windowEnd : null,
    });
    if (!initial) {
      setTitle("");
      setEffort("");
      setDueDate("");
      setRecur("");
      setWindowOpen(false);
      setWindowDays([1, 2, 3, 4, 5]);
      setWindowStart("09:00");
      setWindowEnd("17:00");
    }
  }

  function toggleDay(day: number) {
    setWindowDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day],
    );
  }

  return (
    <form onSubmit={submit} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <input
        autoFocus={autoFocus}
        placeholder="What needs doing?"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        style={{ flex: "1 1 240px" }}
      />
      <select value={categoryId} onChange={(e) => setCategoryId(Number(e.target.value))}>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      {goals && goals.length > 0 && (
        <select
          value={goalId}
          onChange={(e) => setGoalId(e.target.value === "" ? "" : Number(e.target.value))}
          title="Link to a goal (enables impact rating)"
        >
          <option value="">no goal</option>
          {goals.map((g) => (
            <option key={g.id} value={g.id}>
              🎯 {g.title}
            </option>
          ))}
        </select>
      )}
      {goalId !== "" && <StarPicker value={impact} onChange={setImpact} />}
      <input
        type="number"
        min={1}
        placeholder="min"
        title="Effort estimate in minutes"
        value={effort}
        onChange={(e) => setEffort(e.target.value)}
        style={{ width: 76 }}
      />
      <input
        type="date"
        title="Due date (optional)"
        value={dueDate}
        onChange={(e) => setDueDate(e.target.value)}
        style={{ width: 148 }}
      />
      <input
        type="number"
        min={1}
        placeholder="↻ days"
        title="Repeat every N days (optional)"
        value={recur}
        onChange={(e) => setRecur(e.target.value)}
        style={{ width: 84 }}
      />
      <button
        type="button"
        title="Availability window — only draw this task on certain weekdays and times"
        aria-pressed={windowOpen}
        onClick={() => setWindowOpen((o) => !o)}
        style={windowOpen ? undefined : { opacity: 0.7 }}
      >
        🕒 availability
      </button>
      <button type="submit" className="primary">
        {submitLabel ?? "Add"}
      </button>
      {onCancel && (
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      )}
      {windowOpen && (
        <div
          style={{
            flexBasis: "100%",
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          {WEEKDAYS.map(({ day, label }) => (
            <span
              key={day}
              className={`chip ${windowDays.includes(day) ? "active" : ""}`}
              role="checkbox"
              aria-checked={windowDays.includes(day)}
              aria-label={label}
              onClick={() => toggleDay(day)}
              style={{ cursor: "pointer", opacity: windowDays.includes(day) ? 1 : 0.5 }}
            >
              {label}
            </span>
          ))}
          <input
            type="time"
            title="Window opens (inclusive)"
            aria-label="Window start"
            value={windowStart}
            onChange={(e) => setWindowStart(e.target.value)}
          />
          –
          <input
            type="time"
            title="Window closes (exclusive)"
            aria-label="Window end"
            value={windowEnd}
            onChange={(e) => setWindowEnd(e.target.value)}
          />
        </div>
      )}
    </form>
  );
}
