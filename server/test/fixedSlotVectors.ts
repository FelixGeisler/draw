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
