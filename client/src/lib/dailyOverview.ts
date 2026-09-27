import { parsePushStatus, validIanaTimezone } from "../services/pushNotifications";

export type OverviewTimezoneSelection =
  | { ok: true; timezone: string; source: "saved" | "detected" }
  | { ok: false };

/** Pure precedence/validation rule used by TodayPage and its unit tests. */
export function selectOverviewTimezone(
  pushStatus: unknown,
  detectedTimezone: unknown,
): OverviewTimezoneSelection {
  try {
    const saved = parsePushStatus(pushStatus).preferences.timezone;
    if (saved !== null && validIanaTimezone(saved)) {
      return { ok: true, timezone: saved, source: "saved" };
    }
  } catch {
    // A failed or malformed status response has the same bounded fallback as
    // a null saved zone. It is never treated as an empty overview.
  }
  return validIanaTimezone(detectedTimezone)
    ? { ok: true, timezone: detectedTimezone, source: "detected" }
    : { ok: false };
}
