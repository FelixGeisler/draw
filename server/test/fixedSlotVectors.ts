export const supportedAutomationSlotVectors = [
  {
    name: "UTC",
    slot: {
      startLocal: "2026-10-20T10:00",
      endLocal: "2026-10-20T11:00",
      entryTimezone: "UTC",
    },
    startsAt: "2026-10-20T10:00:00.000Z",
    endsAt: "2026-10-20T11:00:00.000Z",
    startOffsetSeconds: 0,
    endOffsetSeconds: 0,
  },
  {
    name: "Berlin earlier fold",
    slot: {
      startLocal: "2026-10-25T02:30",
      endLocal: "2026-10-25T03:30",
      entryTimezone: "Europe/Berlin",
    },
    startsAt: "2026-10-25T00:30:00.000Z",
    endsAt: "2026-10-25T02:30:00.000Z",
    startOffsetSeconds: 7200,
    endOffsetSeconds: 3600,
  },
  {
    name: "New York earlier fold",
    slot: {
      startLocal: "2026-11-01T01:30",
      endLocal: "2026-11-01T02:30",
      entryTimezone: "America/New_York",
    },
    startsAt: "2026-11-01T05:30:00.000Z",
    endsAt: "2026-11-01T07:30:00.000Z",
    startOffsetSeconds: -14400,
    endOffsetSeconds: -18000,
  },
] as const;

export const validUtcBoundarySlots = [
  {
    name: "lower UTC boundary",
    slot: {
      startLocal: "0001-01-01T00:00",
      endLocal: "0001-01-01T00:01",
      entryTimezone: "UTC",
    },
    startsAt: "0001-01-01T00:00:00.000Z",
    endsAt: "0001-01-01T00:01:00.000Z",
  },
  {
    name: "upper UTC boundary",
    slot: {
      startLocal: "9999-12-31T23:58",
      endLocal: "9999-12-31T23:59",
      entryTimezone: "UTC",
    },
    startsAt: "9999-12-31T23:58:00.000Z",
    endsAt: "9999-12-31T23:59:00.000Z",
  },
] as const;

export const namedZoneBoundaryFailures = [
  {
    name: "positive-offset lower-bound underflow",
    slot: {
      startLocal: "0001-01-01T00:00",
      endLocal: "0001-01-01T00:01",
      entryTimezone: "Europe/Berlin",
    },
  },
  {
    name: "negative-offset upper-bound overflow",
    slot: {
      startLocal: "9999-12-31T23:58",
      endLocal: "9999-12-31T23:59",
      entryTimezone: "America/New_York",
    },
  },
] as const;

export const rejectedScheduleZones = [
  "UTC+01:00",
  "+01:00",
  "CET",
  "Etc/GMT+1",
  "US/Eastern",
  "europe/Berlin",
  " Europe/Berlin",
  "Europe/Berlin ",
  "Europe/Bérlin",
  "x".repeat(129),
  "Mars/Olympus_Mons",
] as const;

export const forbiddenFixedSlotInput = {
  fixedSlot: {
    startLocal: "2026-10-20T10:00",
    endLocal: "2026-10-20T11:00",
    entryTimezone: "UTC",
  },
  startsAt: "2026-10-20T10:00:00.000Z",
  endsAt: "2026-10-20T11:00:00.000Z",
  startOffsetSeconds: 0,
  endOffsetSeconds: 0,
} as const;
