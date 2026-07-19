import { describe, expect, it } from "vitest";
import type { ActivityCard, ActivityDay } from "../hooks/useActivity";
import {
  activityLevel,
  buildCalendar,
  dayRarity,
  mondayOf,
  weekdayIndex,
} from "./historyCalendar";

// Pure layout/derivation for the History contribution calendar (#174). No DOM,
// no clock — `today` is injected — so these pin the week bucketing, intensity
// buckets and per-day rarity exactly. Anchor dates: 2026-07-13 is a Monday and
// 2026-07-19 a Sunday (the app's Monday-first week).

function card(over: Partial<ActivityCard> = {}): ActivityCard {
  return {
    taskId: 1,
    title: "t",
    categoryId: 1,
    categoryColor: "#fff",
    effortMinutes: 10,
    impact: 3,
    trackedMinutes: 10,
    completed: true,
    xpAwarded: 10,
    wasDrawn: false,
    ...over,
  };
}

function day(date: string, totals: Partial<ActivityDay["totals"]>, cards: ActivityCard[] = []): ActivityDay {
  return {
    date,
    cards,
    totals: { started: 0, completed: 0, minutes: 0, xp: 0, ...totals },
  };
}

/** Dense [from,to] range of empty days, so buildCalendar sees the shape it expects. */
function emptyRange(from: string, to: string): ActivityDay[] {
  const out: ActivityDay[] = [];
  for (let d = from; d <= to; d = addOne(d)) out.push(day(d, {}));
  return out;
}
function addOne(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

describe("weekdayIndex", () => {
  it("is Monday=0 … Sunday=6", () => {
    expect(weekdayIndex("2026-07-13")).toBe(0); // Monday
    expect(weekdayIndex("2026-07-15")).toBe(2); // Wednesday
    expect(weekdayIndex("2026-07-19")).toBe(6); // Sunday
  });
});

describe("mondayOf", () => {
  it("snaps back to the week's Monday and is idempotent on a Monday", () => {
    expect(mondayOf("2026-07-19")).toBe("2026-07-13"); // Sunday → its Monday
    expect(mondayOf("2026-07-15")).toBe("2026-07-13"); // Wednesday → its Monday
    expect(mondayOf("2026-07-13")).toBe("2026-07-13"); // Monday → itself
  });
});

describe("activityLevel", () => {
  it("is 0 only when nothing was started that day", () => {
    expect(activityLevel({ started: 0, completed: 0, minutes: 0, xp: 0 })).toBe(0);
  });

  it("lights a completion-only day (0 tracked minutes) at the lowest active level", () => {
    // Marked done with no timer: started>0, minutes 0 → level 1, not empty.
    expect(activityLevel({ started: 1, completed: 0, minutes: 0, xp: 0 })).toBe(1);
  });

  it("climbs by tracked minutes", () => {
    expect(activityLevel({ started: 1, completed: 0, minutes: 15, xp: 0 })).toBe(2);
    expect(activityLevel({ started: 1, completed: 0, minutes: 45, xp: 0 })).toBe(3);
    expect(activityLevel({ started: 1, completed: 0, minutes: 90, xp: 0 })).toBe(4);
  });

  it("also climbs by completion count when minutes are low", () => {
    expect(activityLevel({ started: 3, completed: 2, minutes: 5, xp: 0 })).toBe(3);
    expect(activityLevel({ started: 3, completed: 3, minutes: 5, xp: 0 })).toBe(4);
  });
});

describe("dayRarity", () => {
  it("takes the rarest COMPLETED card (holo > silver > none)", () => {
    const d = day("2026-07-13", { started: 3, completed: 3 }, [
      card({ completed: true, wasDrawn: true, impact: 4 }), // silver
      card({ completed: true, wasDrawn: true, impact: 5 }), // holo
      card({ completed: true, wasDrawn: false, impact: 5 }), // none (not drawn)
    ]);
    expect(dayRarity(d)).toBe("holo");
  });

  it("ignores rarity carried by an unfinished card", () => {
    const d = day("2026-07-13", { started: 1, completed: 0 }, [
      card({ completed: false, wasDrawn: true, impact: 5 }),
    ]);
    expect(dayRarity(d)).toBe("none");
  });
});

describe("buildCalendar", () => {
  it("groups a dense range into Monday-first week columns with month labels", () => {
    const days = emptyRange("2026-06-29", "2026-07-12"); // Mon … Sun, exactly 2 weeks
    const { columns } = buildCalendar(days, "2026-06-29", "2026-07-12", "2026-07-19");
    expect(columns).toHaveLength(2);
    expect(columns[0].cells).toHaveLength(7);
    expect(columns[0].cells[0].date).toBe("2026-06-29");
    expect(columns[0].cells[6].date).toBe("2026-07-05");
    // First column labels its month; the next column opens July.
    expect(columns[0].monthLabel).toBe("Jun");
    expect(columns[1].monthLabel).toBe("Jul");
  });

  it("pads the final week's future days past `to`", () => {
    const days = emptyRange("2026-07-13", "2026-07-15"); // Mon … Wed
    const { columns } = buildCalendar(days, "2026-07-13", "2026-07-15", "2026-07-15");
    expect(columns).toHaveLength(1);
    expect(columns[0].cells[2].date).toBe("2026-07-15");
    expect(columns[0].cells[2].isToday).toBe(true);
    // Thu … Sun are inert padding.
    expect(columns[0].cells.slice(3).every((c) => c.date === null)).toBe(true);
  });

  it("pads leading days when `from` is not a Monday", () => {
    const days = emptyRange("2026-07-15", "2026-07-16"); // Wed, Thu
    const { columns } = buildCalendar(days, "2026-07-15", "2026-07-16", "2026-07-19");
    expect(columns).toHaveLength(1);
    expect(columns[0].weekStart).toBe("2026-07-13");
    expect(columns[0].cells[0].date).toBe(null); // Mon, before `from`
    expect(columns[0].cells[1].date).toBe(null); // Tue, before `from`
    expect(columns[0].cells[2].date).toBe("2026-07-15"); // Wed, first in range
  });

  it("sums the window summary over active days only", () => {
    const days = [
      day("2026-07-13", { started: 2, completed: 1, minutes: 30, xp: 20 }),
      day("2026-07-14", { started: 0, completed: 0, minutes: 0, xp: 0 }), // empty
      day("2026-07-15", { started: 1, completed: 1, minutes: 12, xp: 16 }),
    ];
    const { summary } = buildCalendar(days, "2026-07-13", "2026-07-15", "2026-07-19");
    expect(summary).toEqual({ activeDays: 2, completed: 2, minutes: 42, xp: 36 });
  });
});
