/**
 * Snooze presets (issue #19). Pure date math with an injectable `now` so the
 * presets are unit-testable; all times are the user's local wall clock — the
 * resulting Date is sent to the API as a UTC ISO string.
 */

export interface SnoozePreset {
  key: string;
  label: string;
  until: (now: Date) => Date;
}

/** Local `hour`:00 on the day `dayOffset` days from `base`. */
function at(base: Date, dayOffset: number, hour: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d;
}

export const SNOOZE_PRESETS: SnoozePreset[] = [
  { key: "hour", label: "1 hour", until: (now) => new Date(now.getTime() + 60 * 60_000) },
  {
    key: "evening",
    label: "This evening",
    // Today 18:00 — or tomorrow's evening when 18:00 already passed.
    until: (now) => (now.getHours() < 18 ? at(now, 0, 18) : at(now, 1, 18)),
  },
  { key: "tomorrow", label: "Tomorrow", until: (now) => at(now, 1, 8) },
  { key: "next-week", label: "Next week", until: (now) => at(now, 7, 8) },
];

/**
 * A picked calendar date ("YYYY-MM-DD" from an <input type="date">) wakes the
 * task at local midnight, so it is back in the deck on that day.
 */
export function wakeDateFromInput(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}
