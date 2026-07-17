import { describe, expect, it, vi } from "vitest";
import {
  AiError,
  isStaleFileIdError,
  usesFileSource,
  withFileIdRetry,
  type ContentBlock,
} from "../../src/services/aiService.js";

// The file-id cache policy (#92, ADR-35) is the one part of the Files-API
// change that can be pinned without a key: block classification and the
// retry-once-on-stale-id decision are pure, so they get exercised here in
// full. The live upload/parse path is mocked at the SDK boundary in the
// integration suite, and verified for real under #91.

const fileBlock: ContentBlock = {
  type: "document",
  source: { type: "file", file_id: "file_abc" },
  title: "notes.pdf",
};
const base64Block: ContentBlock = {
  type: "document",
  source: { type: "base64", media_type: "application/pdf", data: "AAAA" },
  title: "notes.pdf",
};
const textBlock: ContentBlock = { type: "text", text: "a user note" };

describe("usesFileSource — which blocks reference a Files-API id", () => {
  it("is true only for a document block whose source is a file id", () => {
    expect(usesFileSource(fileBlock)).toBe(true);
    expect(usesFileSource(base64Block)).toBe(false);
    expect(usesFileSource(textBlock)).toBe(false);
  });
});

describe("isStaleFileIdError — telling 'that file_id is gone' from every other failure", () => {
  const withFile = [textBlock, fileBlock];
  const withoutFile = [textBlock, base64Block];

  it("treats a 404 as stale, but only when a file id was actually referenced", () => {
    const notFound = new AiError(502, "Claude API error: not found", 404);
    expect(isStaleFileIdError(notFound, withFile)).toBe(true);
    // A 404 on a request that referenced no file id is somebody else's 404
    // (a bad model id, say) — re-uploading would be pointless.
    expect(isStaleFileIdError(notFound, withoutFile)).toBe(false);
  });

  it("treats a file-mentioning 400 as stale (the slack the no-key repo needs)", () => {
    const badFile = new AiError(502, "Claude API error: file_abc not found", 400);
    expect(isStaleFileIdError(badFile, withFile)).toBe(true);
  });

  it("does NOT treat an unrelated 400 as stale", () => {
    const other = new AiError(502, "Claude API error: messages: too many blocks", 400);
    expect(isStaleFileIdError(other, withFile)).toBe(false);
  });

  it("ignores rate limits, connection errors and our own over-limit 400", () => {
    expect(isStaleFileIdError(new AiError(429, "rate limit", 429), withFile)).toBe(false);
    expect(isStaleFileIdError(new AiError(502, "no connection", undefined), withFile)).toBe(false);
    // guardTokens' own over-limit AiError carries no sdkStatus — never a re-upload.
    expect(isStaleFileIdError(new AiError(400, "materials are too large"), withFile)).toBe(false);
  });

  it("ignores non-AiError throwables", () => {
    expect(isStaleFileIdError(new Error("boom"), withFile)).toBe(false);
    expect(isStaleFileIdError("nope", withFile)).toBe(false);
  });
});

describe("withFileIdRetry — rebuild once when a cached id is rejected", () => {
  it("builds and runs once on the happy path, without invalidating", async () => {
    const build = vi.fn(async () => [fileBlock]);
    const run = vi.fn(async () => "ok");
    const invalidate = vi.fn();

    await expect(withFileIdRetry(build, run, invalidate)).resolves.toBe("ok");
    expect(build).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("invalidates and rebuilds exactly once when the first run hits a stale id", async () => {
    const build = vi.fn(async () => [fileBlock]);
    const run = vi
      .fn()
      .mockRejectedValueOnce(new AiError(502, "file gone", 404))
      .mockResolvedValueOnce("healed");
    const invalidate = vi.fn();

    await expect(withFileIdRetry(build, run, invalidate)).resolves.toBe("healed");
    // Order matters: invalidate before the rebuild, so the second build
    // re-uploads from disk instead of reading the dropped id.
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("propagates a non-stale error without retrying or invalidating", async () => {
    const build = vi.fn(async () => [fileBlock]);
    const run = vi.fn().mockRejectedValue(new AiError(429, "rate limit", 429));
    const invalidate = vi.fn();

    await expect(withFileIdRetry(build, run, invalidate)).rejects.toMatchObject({ status: 429 });
    expect(build).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("retries only once — a second stale rejection surfaces rather than looping", async () => {
    const build = vi.fn(async () => [fileBlock]);
    const run = vi.fn().mockRejectedValue(new AiError(502, "file still gone", 404));
    const invalidate = vi.fn();

    await expect(withFileIdRetry(build, run, invalidate)).rejects.toMatchObject({ sdkStatus: 404 });
    expect(build).toHaveBeenCalledTimes(2); // original + one rebuild
    expect(run).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
