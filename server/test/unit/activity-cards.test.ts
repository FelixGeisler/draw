import { describe, expect, it } from "vitest";
import {
  addDays,
  buildActivityDays,
  localDayOf,
  type ActivityCompletionRow,
  type ActivityEntryRow,
  type ActivityTaskMeta,
} from "../../src/services/activityService.js";

// Pure card derivation for the history skyline (#53). All buildActivityDays
// cases pass an explicit offset so the assertions hold on any machine/TZ:
// offset 0 = "server lives in UTC", offset 120 = UTC+2 (a Berlin summer).

const META: ActivityTaskMeta[] = [
  {
    taskId: 1,
    title: "write essay",
    categoryId: 1,
    categoryColor: "#4f8cff",
    effortMinutes: 30,
    impact: 5,
  },
  {
    taskId: 2,
    title: "water plants",
    categoryId: 3,
    categoryColor: "#3fbf7f",
    effortMinutes: 10,
    impact: 3,
  },
];

const entry = (over: Partial<ActivityEntryRow>): ActivityEntryRow => ({
  taskId: 1,
  startedAt: "2026-07-14T10:00:00.000Z",
  minutes: 25,
  ...over,
});

const completion = (over: Partial<ActivityCompletionRow>): ActivityCompletionRow => ({
  taskId: 1,
  completedAt: "2026-07-14T18:00:00.000Z",
  xpAwarded: 30,
  wasDrawn: 0,
  ...over,
});

describe("localDayOf (local-day bucketing)", () => {
  it("keeps a 23:30-local start on that evening's day, not the UTC day", () => {
    // 21:30Z at UTC+2 is 23:30 on July 15 — UTC bucketing would say July 15
    // too, so pin the interesting instant: 22:30Z is already July 16 in UTC+2.
    expect(localDayOf("2026-07-15T21:30:00.000Z", 120)).toBe("2026-07-15");
    expect(localDayOf("2026-07-15T22:30:00.000Z", 120)).toBe("2026-07-16");
  });

  it("shifts early-UTC instants back a day for negative offsets", () => {
    // 03:00Z at UTC-5 is 22:00 the previous evening.
    expect(localDayOf("2026-07-15T03:00:00.000Z", -300)).toBe("2026-07-14");
  });

  it("is the identity for offset 0", () => {
    expect(localDayOf("2026-07-15T00:00:00.000Z", 0)).toBe("2026-07-15");
    expect(localDayOf("2026-07-15T23:59:59.999Z", 0)).toBe("2026-07-15");
  });
});

describe("buildActivityDays", () => {
  it("derives face-down for worked-not-completed and upright for completed", () => {
    const days = buildActivityDays(
      [entry({ taskId: 1 })],
      [completion({ taskId: 2, xpAwarded: 12, wasDrawn: 1 })],
      META,
      "2026-07-14",
      "2026-07-14",
      0,
    );
    expect(days).toHaveLength(1);
    const [worked, done] = days[0].cards;
    expect(worked).toMatchObject({ taskId: 1, completed: false, trackedMinutes: 25, xpAwarded: 0 });
    expect(done).toMatchObject({ taskId: 2, completed: true, xpAwarded: 12, wasDrawn: true });
    // Rarity facts (#62): impact passes through from the live task meta, so
    // the client can derive holo/silver on upright cards without new state.
    expect(worked.impact).toBe(5);
    expect(done.impact).toBe(3);
  });

  it("keeps the earlier face-down card when the task completes a day later", () => {
    const days = buildActivityDays(
      [entry({ startedAt: "2026-07-14T10:00:00.000Z" })],
      [completion({ completedAt: "2026-07-15T09:00:00.000Z", xpAwarded: 30 })],
      META,
      "2026-07-14",
      "2026-07-15",
      0,
    );
    expect(days[0].cards).toEqual([
      expect.objectContaining({ taskId: 1, completed: false, trackedMinutes: 25 }),
    ]);
    expect(days[1].cards).toEqual([
      expect.objectContaining({ taskId: 1, completed: true, trackedMinutes: 0, xpAwarded: 30 }),
    ]);
  });

  it("yields one card per (task, day) and sums minutes across entries", () => {
    const days = buildActivityDays(
      [
        entry({ startedAt: "2026-07-14T09:00:00.000Z", minutes: 20.4 }),
        entry({ startedAt: "2026-07-14T15:00:00.000Z", minutes: 30.4 }),
      ],
      [],
      META,
      "2026-07-14",
      "2026-07-14",
      0,
    );
    expect(days[0].cards).toHaveLength(1);
    // 50.8 raw → rounded once at the end, not per entry
    expect(days[0].cards[0].trackedMinutes).toBe(51);
    expect(days[0].totals).toEqual({ started: 1, completed: 0, minutes: 51, xp: 0 });
  });

  it("gives a completion without any time entry an upright card (union rule)", () => {
    const days = buildActivityDays(
      [],
      [completion({ taskId: 2, xpAwarded: 7 })],
      META,
      "2026-07-14",
      "2026-07-14",
      0,
    );
    expect(days[0].cards).toEqual([
      expect.objectContaining({
        taskId: 2,
        completed: true,
        trackedMinutes: 0,
        effortMinutes: 10, // the client's size fallback for completion-only cards
        xpAwarded: 7,
      }),
    ]);
  });

  it("buckets a 23:30-local entry on that evening's tower, not the next UTC day", () => {
    // The acceptance case verbatim: started 2026-07-14 23:30 local at UTC-5,
    // which is 2026-07-15T04:30Z — its UTC date is already the 15th. Local
    // bucketing must land it on the 14th's tower.
    const days = buildActivityDays(
      [entry({ startedAt: "2026-07-15T04:30:00.000Z" })],
      [],
      META,
      "2026-07-14",
      "2026-07-15",
      -300,
    );
    expect(days[0].cards).toHaveLength(1);
    expect(days[1].cards).toHaveLength(0);
  });

  it("stacks cards in start order, completions count via their timestamp", () => {
    const days = buildActivityDays(
      [entry({ taskId: 1, startedAt: "2026-07-14T12:00:00.000Z" })],
      [completion({ taskId: 2, completedAt: "2026-07-14T08:00:00.000Z" })],
      META,
      "2026-07-14",
      "2026-07-14",
      0,
    );
    expect(days[0].cards.map((c) => c.taskId)).toEqual([2, 1]);
  });

  it("includes empty days as empty towers and drops rows outside the range", () => {
    const days = buildActivityDays(
      [entry({ startedAt: "2026-07-10T10:00:00.000Z" })], // before the range
      [completion({ completedAt: "2026-07-15T10:00:00.000Z" })],
      META,
      "2026-07-13",
      "2026-07-15",
      0,
    );
    expect(days.map((d) => d.date)).toEqual(["2026-07-13", "2026-07-14", "2026-07-15"]);
    expect(days[0].cards).toHaveLength(0);
    expect(days[0].totals).toEqual({ started: 0, completed: 0, minutes: 0, xp: 0 });
    expect(days[1].cards).toHaveLength(0);
    expect(days[2].cards).toHaveLength(1);
  });

  it("sums XP and ORs wasDrawn when a recurring task completes twice a day", () => {
    const days = buildActivityDays(
      [],
      [
        completion({ taskId: 2, completedAt: "2026-07-14T08:00:00.000Z", xpAwarded: 10, wasDrawn: 0 }),
        completion({ taskId: 2, completedAt: "2026-07-14T19:00:00.000Z", xpAwarded: 15, wasDrawn: 1 }),
      ],
      META,
      "2026-07-14",
      "2026-07-14",
      0,
    );
    expect(days[0].cards).toEqual([
      expect.objectContaining({ taskId: 2, completed: true, xpAwarded: 25, wasDrawn: true }),
    ]);
    expect(days[0].totals).toEqual({ started: 1, completed: 1, minutes: 0, xp: 25 });
  });
});

describe("addDays", () => {
  it("does date-only arithmetic across month boundaries", () => {
    expect(addDays("2026-07-01", -1)).toBe("2026-06-30");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});
