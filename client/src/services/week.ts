import { SCHEDULE_TIME_ZONE_SET } from "../../../shared/scheduleTimezones";
import {
  parseWeekResponseJson,
  type WeekResponse,
  type WeekValidationContext,
} from "../../../shared/weekContract";

export type WeekFailureCode =
  | "invalid-week-request"
  | "week-projection-busy"
  | "week-index-unavailable"
  | "week-projection-failed"
  | "invalid-week-response"
  | "week-network-failed";

export class WeekRequestError extends Error {
  constructor(
    public readonly code: WeekFailureCode,
    public readonly status: number | null,
  ) {
    super(code);
  }
}

function exactError(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  const error = (value as { error?: unknown }).error;
  return keys.length === 1 && keys[0] === "error" && typeof error === "string" ? error : null;
}

function recognizedFailure(status: number, value: unknown): WeekFailureCode {
  const code = exactError(value);
  if (status === 400 && code === "invalid-week-request") return code;
  if (status === 503 && (code === "week-projection-busy" || code === "week-index-unavailable")) return code;
  if (status === 500 && code === "week-projection-failed") return code;
  return "invalid-week-response";
}

export async function fetchWeekPage(
  context: WeekValidationContext,
  cursor: string | null,
  signal: AbortSignal,
): Promise<WeekResponse> {
  const params = new URLSearchParams({
    weekStart: context.weekStart,
    timezone: context.timezone,
  });
  if (cursor !== null) params.set("cursor", cursor);
  let response: Response;
  try {
    response = await fetch(`/api/calendar/week?${params}`, {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new WeekRequestError("week-network-failed", null);
  }
  const text = await response.text();
  if (!response.ok) {
    let value: unknown;
    try { value = JSON.parse(text) as unknown; } catch { value = null; }
    throw new WeekRequestError(recognizedFailure(response.status, value), response.status);
  }
  if (response.status !== 200) throw new WeekRequestError("invalid-week-response", response.status);
  try {
    return parseWeekResponseJson(text, context, SCHEDULE_TIME_ZONE_SET);
  } catch {
    throw new WeekRequestError("invalid-week-response", response.status);
  }
}
