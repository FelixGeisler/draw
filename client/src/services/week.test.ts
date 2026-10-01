import { afterEach, describe, expect, it, vi } from "vitest";
import { createWeekContext } from "../lib/week";
import { fetchWeekPage, WeekRequestError } from "./week";

const context = createWeekContext("2026-10-26", "Europe/Berlin")!;
const valid = {
  weekStart: "2026-10-26",
  timezone: "Europe/Berlin",
  requestNow: "2026-10-29T12:00:00.000Z",
  records: [{
    kind: "task",
    id: 42,
    title: "<img src=x onerror=alert(1)>",
    titleTruncated: false,
    status: "open",
    fixed: {
      startsAt: "2026-10-27T08:00:00.000Z",
      endsAt: "2026-10-27T09:30:00.000Z",
      contextDate: "2026-10-27",
    },
    deadline: { date: "2026-10-30" },
  }],
  nextCursor: null,
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchWeekPage", () => {
  it("requests no-store and accepts only the shared strict contract", async () => {
    const fetch = vi.fn(async () => response(valid));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchWeekPage(context, null, new AbortController().signal)).resolves.toEqual(valid);
    expect(fetch).toHaveBeenCalledWith(
      "/api/calendar/week?weekStart=2026-10-26&timezone=Europe%2FBerlin",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
  });

  it.each([
    ["extra envelope key", { ...valid, extra: true }],
    ["wrong field type", { ...valid, records: [{ ...valid.records[0], id: "42" }] }],
    ["invariant-breaking context date", { ...valid, records: [{ ...valid.records[0], fixed: { ...valid.records[0].fixed, contextDate: null } }] }],
    ["partial malformed JSON", "not-json"],
  ])("rejects the whole %s page", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn(async () => body === "not-json"
      ? new Response("{", { status: 200 })
      : response(body)));
    await expect(fetchWeekPage(context, null, new AbortController().signal))
      .rejects.toMatchObject({ code: "invalid-week-response" });
  });

  it.each([
    [400, { error: "invalid-week-request" }, "invalid-week-request"],
    [503, { error: "week-projection-busy" }, "week-projection-busy"],
    [503, { error: "week-index-unavailable" }, "week-index-unavailable"],
    [500, { error: "week-projection-failed" }, "week-projection-failed"],
    [503, { error: "other", detail: "leak" }, "invalid-week-response"],
  ])("maps exact recoverable HTTP %s body without accepting records", async (status, body, code) => {
    vi.stubGlobal("fetch", vi.fn(async () => response(body, status)));
    try {
      await fetchWeekPage(context, null, new AbortController().signal);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(WeekRequestError);
      expect(error).toMatchObject({ code, status });
    }
  });

  it("sends a continuation only when explicitly supplied", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(valid)));
    const cursor = "abc.def";
    await fetchWeekPage(context, cursor, new AbortController().signal);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("&cursor=abc.def"),
      expect.anything(),
    );
  });
});
