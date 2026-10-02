import { Router, type Request } from "express";
import { db } from "../db.js";
import { WEEK_MAX_SAFE_ID, parseWeekTimestamp } from "../schemaV23.js";

const MAX_REQUEST_TARGET_BYTES = 2_048;
const PAGE_SIZE = 100;

type ForestEndReason = "done" | "stop";
type ForestTree = {
  id: number;
  startedAt: string;
  endedAt: string;
  endReason: ForestEndReason;
};

export function parseForestQueryTarget(target: string): number | null | undefined {
  if (Buffer.byteLength(target, "utf8") > MAX_REQUEST_TARGET_BYTES) return undefined;
  if (target === "/api/forest") return null;
  const match = /^\/api\/forest\?beforeId=([1-9][0-9]{0,15})$/.exec(target);
  if (!match) return undefined;
  const beforeId = Number(match[1]);
  return Number.isSafeInteger(beforeId) && beforeId > 0 && beforeId <= WEEK_MAX_SAFE_ID
    ? beforeId
    : undefined;
}

function parseQuery(req: Request): number | null | undefined {
  return parseForestQueryTarget(req.originalUrl);
}

function readForestPage(beforeId: number | null): {
  trees: ForestTree[];
  nextBeforeId: number | null;
} {
  const cursorPredicate = beforeId === null ? "" : "AND id < ?";
  const bindings = beforeId === null ? [] : [beforeId];
  const malformed = db.prepare(`SELECT 1 FROM time_entries
    WHERE end_reason IS NOT NULL ${cursorPredicate} AND NOT (
      typeof(id)='integer' AND id BETWEEN 1 AND 9007199254740991
      AND typeof(end_reason)='text' AND end_reason IN ('done','stop')
      AND ended_at IS NOT NULL
      AND CASE WHEN typeof(started_at)='text'
               THEN CASE WHEN octet_length(started_at)=24 THEN 1 ELSE 0 END ELSE 0 END=1
      AND CASE WHEN typeof(ended_at)='text'
               THEN CASE WHEN octet_length(ended_at)=24 THEN 1 ELSE 0 END ELSE 0 END=1
    ) LIMIT 1`).get(...bindings);
  if (malformed) throw new Error("forest classified row storage domain");

  const rows = db.prepare(`SELECT id,started_at AS startedAt,ended_at AS endedAt,
      end_reason AS endReason
    FROM time_entries
    WHERE end_reason IS NOT NULL ${cursorPredicate}
    ORDER BY id DESC LIMIT 101`).all(...bindings) as ForestTree[];

  let previous = beforeId ?? WEEK_MAX_SAFE_ID + 1;
  for (const row of rows) {
    const start = parseWeekTimestamp(row.startedAt, "forest start");
    const end = parseWeekTimestamp(row.endedAt, "forest end");
    if (
      !Number.isSafeInteger(row.id) ||
      row.id < 1 ||
      row.id > WEEK_MAX_SAFE_ID ||
      row.id >= previous ||
      start === null ||
      end === null ||
      end < start ||
      (row.endReason !== "done" && row.endReason !== "stop")
    ) {
      throw new Error("forest result contract");
    }
    previous = row.id;
  }

  const trees = rows.slice(0, PAGE_SIZE).map(({ id, startedAt, endedAt, endReason }) => ({
    id,
    startedAt,
    endedAt,
    endReason,
  }));
  return {
    trees,
    nextBeforeId: rows.length === PAGE_SIZE + 1 ? trees[trees.length - 1].id : null,
  };
}

export const forestRouter = Router();

forestRouter.all("/", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "HEAD") return res.status(400).end();
  const failRequest = () => res.status(400).json({ error: "invalid-forest-request" });
  if (
    req.method !== "GET" ||
    req.headers["content-length"] !== undefined ||
    req.headers["transfer-encoding"] !== undefined
  ) {
    return failRequest();
  }
  const beforeId = parseQuery(req);
  if (beforeId === undefined) return failRequest();
  try {
    return res.status(200).json(readForestPage(beforeId));
  } catch {
    return res.status(500).json({ error: "forest-read-failed" });
  }
});
