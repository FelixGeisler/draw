import type { WeekRecord } from "../../shared/weekContract.js";
import type { ResolvedWeek } from "./weekTime.js";

export type WeekWorkerRequest = Readonly<{
  type: "query";
  id: number;
  week: ResolvedWeek;
  requestNow: string;
  after: null | Readonly<{ anchorMs: number; kindRank: 0 | 1 | 2; id: number }>;
}>;

export type WeekWorkerClose = Readonly<{ type: "close" }>;

export type WeekWorkerResult = Readonly<{
  type: "result";
  id: number;
  records: WeekRecord[];
  hasMore: boolean;
  last: null | Readonly<{ anchor: string; kindRank: 0 | 1 | 2; id: number }>;
}>;

export type WeekWorkerFailure = Readonly<{
  type: "failure";
  id: number;
  code: "unavailable" | "failed";
  discard: boolean;
}>;

export type WeekWorkerMessage =
  | Readonly<{ type: "ready" }>
  | Readonly<{ type: "closed" }>
  | WeekWorkerResult
  | WeekWorkerFailure;
