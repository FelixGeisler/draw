import { Router, type Request } from "express";
import { decodeWeekCursor, readWeekPage } from "../db.js";
import { WeekServiceError } from "../weekService.js";
import { resolveWeek } from "../weekTime.js";

const MAX_REQUEST_TARGET_BYTES = 2_048;

type ParsedQuery = { weekStart: string; timezone: string; cursor?: string };

export function parseWeekQueryTarget(target: string): ParsedQuery | null {
  if (Buffer.byteLength(target, "utf8") > MAX_REQUEST_TARGET_BYTES) return null;
  const question = target.indexOf("?");
  const pathname = question < 0 ? target : target.slice(0, question);
  if (pathname !== "/api/calendar/week" || question < 0) return null;
  const raw = target.slice(question + 1);
  if (!raw || raw.includes("#")) return null;
  const result: Partial<ParsedQuery> = {};
  const seen = new Set<string>();
  for (const pair of raw.split("&")) {
    if (!pair) return null;
    const equals = pair.indexOf("=");
    if (equals < 1) return null;
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(pair.slice(0, equals).replaceAll("+", " "));
      value = decodeURIComponent(pair.slice(equals + 1).replaceAll("+", " "));
    } catch {
      return null;
    }
    if (!new Set(["weekStart", "timezone", "cursor"]).has(key) || seen.has(key)) return null;
    seen.add(key);
    if (key === "weekStart") result.weekStart = value;
    else if (key === "timezone") result.timezone = value;
    else result.cursor = value;
  }
  if (typeof result.weekStart !== "string" || typeof result.timezone !== "string") return null;
  return result as ParsedQuery;
}

function parseQuery(req: Request): ParsedQuery | null {
  return parseWeekQueryTarget(req.originalUrl);
}

export const calendarRouter = Router();

calendarRouter.all("/week", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const fail = (status: 400 | 500 | 503, error: string) => res.status(status).json({ error });
  if (
    req.method !== "GET" ||
    req.headers["content-length"] !== undefined ||
    req.headers["transfer-encoding"] !== undefined
  ) {
    return fail(400, "invalid-week-request");
  }
  const query = parseQuery(req);
  if (!query) return fail(400, "invalid-week-request");
  const week = resolveWeek(query.weekStart, query.timezone);
  if (!week) return fail(400, "invalid-week-request");

  let cursor = null;
  if (query.cursor !== undefined) {
    try {
      cursor = decodeWeekCursor(query.cursor, week);
    } catch {
      return fail(400, "invalid-week-request");
    }
  }
  try {
    const response = await readWeekPage(week, cursor);
    return res.status(200).json(response);
  } catch (error) {
    if (error instanceof WeekServiceError) {
      if (error.code === "busy") return fail(503, "week-projection-busy");
      if (error.code === "unavailable") return fail(503, "week-index-unavailable");
    }
    return fail(500, "week-projection-failed");
  }
});
