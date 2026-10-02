import crypto from "node:crypto";
import { isCanonicalInstant } from "../../shared/weekContract.js";
import type { ResolvedWeek } from "./weekTime.js";

export interface WeekCursorPosition {
  requestNow: string;
  anchor: string;
  kindRank: 0 | 1 | 2;
  id: number;
}

interface CursorPayload {
  v: 2;
  w: string;
  z: string;
  n: string;
  a: string;
  k: 0 | 1 | 2;
  i: number;
}

const PAYLOAD_MAX_BYTES = 248;
const PAYLOAD_MAX_CHARS = 331;
const TAG_BYTES = 32;
const TAG_CHARS = 43;
export const WEEK_CURSOR_MAX_CHARS = 375;
export const WEEK_SEMANTIC_CURSOR_MAX_CHARS = 244;

export class WeekCursorError extends Error {
  constructor() {
    super("invalid Week cursor");
  }
}

function invalid(): never {
  throw new WeekCursorError();
}

function strictDecode(segment: string, maxChars: number, maxBytes: number): Buffer {
  if (segment.length < 1 || segment.length > maxChars || !/^[A-Za-z0-9_-]+$/.test(segment)) invalid();
  let decoded: Buffer;
  try {
    decoded = Buffer.from(segment, "base64url");
  } catch {
    invalid();
  }
  if (decoded.length > maxBytes || decoded.toString("base64url") !== segment) invalid();
  return decoded;
}

export interface WeekCursorCodec {
  encode(week: ResolvedWeek, position: WeekCursorPosition): string;
  decode(cursor: unknown, week: ResolvedWeek): WeekCursorPosition;
  rotate(): void;
}

export function createWeekCursorCodec(initialKey?: Buffer): WeekCursorCodec {
  let key = initialKey ? Buffer.from(initialKey) : crypto.randomBytes(32);
  if (key.length !== 32) throw new Error("Week cursor key must contain 32 bytes");

  const encode = (week: ResolvedWeek, position: WeekCursorPosition): string => {
    if (
      !isCanonicalInstant(position.requestNow) ||
      !isCanonicalInstant(position.anchor) ||
      Date.parse(position.anchor) < week.rangeStartMs ||
      Date.parse(position.anchor) >= week.rangeEndMs ||
      ![0, 1, 2].includes(position.kindRank) ||
      !Number.isSafeInteger(position.id) ||
      position.id <= 0
    ) {
      throw new Error("cannot encode invalid Week cursor state");
    }
    const payload: CursorPayload = {
      v: 2,
      w: week.weekStart,
      z: week.timezone,
      n: position.requestNow,
      a: position.anchor,
      k: position.kindRank,
      i: position.id,
    };
    const bytes = Buffer.from(JSON.stringify(payload), "utf8");
    const tag = crypto.createHmac("sha256", key).update(bytes).digest();
    const wire = `${bytes.toString("base64url")}.${tag.toString("base64url")}`;
    if (wire.length > WEEK_SEMANTIC_CURSOR_MAX_CHARS) {
      throw new Error("semantically valid Week cursor exceeded its registry bound");
    }
    return wire;
  };

  const decode = (cursor: unknown, week: ResolvedWeek): WeekCursorPosition => {
    if (
      typeof cursor !== "string" ||
      cursor.length < 3 ||
      cursor.length > WEEK_CURSOR_MAX_CHARS ||
      !/^[\x00-\x7f]+$/.test(cursor)
    ) invalid();
    const dot = cursor.indexOf(".");
    if (dot <= 0 || dot !== cursor.lastIndexOf(".")) invalid();
    const payloadSegment = cursor.slice(0, dot);
    const tagSegment = cursor.slice(dot + 1);
    const payloadBytes = strictDecode(payloadSegment, PAYLOAD_MAX_CHARS, PAYLOAD_MAX_BYTES);
    const tag = strictDecode(tagSegment, TAG_CHARS, TAG_BYTES);
    if (tag.length !== TAG_BYTES || tagSegment.length !== TAG_CHARS) invalid();

    // Authenticate all 32 bytes before fatal UTF-8 decoding, parsing or use.
    const expected = crypto.createHmac("sha256", key).update(payloadBytes).digest();
    if (!crypto.timingSafeEqual(tag, expected)) invalid();

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
    } catch {
      invalid();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      invalid();
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) invalid();
    const value = parsed as Record<string, unknown>;
    const keys = Object.keys(value);
    if (
      keys.length !== 7 ||
      keys.some((entry, index) => entry !== ["v", "w", "z", "n", "a", "k", "i"][index]) ||
      value.v !== 2 ||
      value.w !== week.weekStart ||
      value.z !== week.timezone ||
      !isCanonicalInstant(value.n) ||
      !isCanonicalInstant(value.a) ||
      !Number.isInteger(value.k) ||
      ![0, 1, 2].includes(value.k as number) ||
      !Number.isSafeInteger(value.i) ||
      (value.i as number) <= 0
    ) invalid();
    if (Buffer.from(JSON.stringify(value), "utf8").compare(payloadBytes) !== 0) invalid();
    const anchorMs = Date.parse(value.a as string);
    if (anchorMs < week.rangeStartMs || anchorMs >= week.rangeEndMs) invalid();
    return {
      requestNow: value.n as string,
      anchor: value.a as string,
      kindRank: value.k as 0 | 1 | 2,
      id: value.i as number,
    };
  };

  return {
    encode,
    decode,
    rotate() {
      key.fill(0);
      key = crypto.randomBytes(32);
    },
  };
}
