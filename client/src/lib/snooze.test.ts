import { describe, expect, it } from "vitest";
import { SNOOZE_PRESETS, wakeDateFromInput } from "./snooze";

// Preset math is local wall clock — construct expectations with the same
// local Date constructors so the tests are timezone-independent.
const MORNING = new Date(2026, 6, 14, 9, 30); // Tue 2026-07-14 09:30 local
const EVENING = new Date(2026, 6, 14, 20, 15); // Tue 2026-07-14 20:15 local

function preset(key: string) {
  const p = SNOOZE_PRESETS.find((p) => p.key === key);
  if (!p) throw new Error(`unknown preset ${key}`);
  return p;
}

describe("snooze presets", () => {
  it("1 hour is exactly now + 60 minutes", () => {
    expect(preset("hour").until(MORNING).getTime()).toBe(MORNING.getTime() + 3_600_000);
  });

  it("this evening means today 18:00 while the evening is still ahead", () => {
    expect(preset("evening").until(MORNING)).toEqual(new Date(2026, 6, 14, 18, 0, 0, 0));
  });

  it("this evening rolls to tomorrow 18:00 once 18:00 has passed", () => {
    expect(preset("evening").until(EVENING)).toEqual(new Date(2026, 6, 15, 18, 0, 0, 0));
  });

  it("tomorrow wakes at 08:00 the next day", () => {
    expect(preset("tomorrow").until(EVENING)).toEqual(new Date(2026, 6, 15, 8, 0, 0, 0));
  });

  it("next week wakes at 08:00 seven days out, crossing the month boundary", () => {
    expect(preset("next-week").until(new Date(2026, 6, 28, 14, 0))).toEqual(
      new Date(2026, 7, 4, 8, 0, 0, 0),
    );
  });
});

describe("wakeDateFromInput", () => {
  it("wakes at local midnight of the picked day", () => {
    expect(wakeDateFromInput("2026-07-20")).toEqual(new Date(2026, 6, 20, 0, 0, 0, 0));
  });
});
