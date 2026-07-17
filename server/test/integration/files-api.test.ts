import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type express from "express";
import {
  COUNT_TOKENS_FILE_SOURCE_ERROR,
  findFileSource,
  freshApp,
  testDb,
} from "../helpers.js";

// Files API for goal materials (#92, ADR-35). The SDK boundary is mocked so
// the whole aiService path around it runs for real: block assembly, the lazy
// once-per-material upload, the file-id retry, and the base64 fallback. Live
// upload/parse cannot run without a key (setup.ts guarantees degraded mode);
// #91 verifies it against the real API.
//
// The mock is the SDK client, NOT aiService — unlike card-art.test.ts, which
// stubs the whole generateCardArt function. Here the logic under test lives
// inside aiService, so only Anthropic itself is replaced.
//
// Since #133 the paid call is `messages.stream()` (the SDK refuses 32K
// non-streaming requests), so the mock mirrors the streaming contract:
// stream() returns synchronously; results AND errors arrive via
// finalMessage(). `streamResolve`/`streamReject` are the per-test knobs.
//
// Since #138 the mocked count_tokens is STRICT: like the live endpoint, it
// rejects any request carrying a `{type: "file"}` document source. The
// permissive mock is what let #136 ship a request shape the real API 400s —
// under this one, the pre-#138 guardTokens would fail every material-backed
// test in this file.
const mocks = vi.hoisted(() => {
  // Error classes live here, not in the vi.mock factory, so beforeEach and
  // individual tests can construct instances that satisfy mapSdkError's
  // instanceof checks against the mocked module.
  class APIError extends Error {
    status?: number;
    constructor(status?: number, message?: string) {
      super(message);
      this.status = status;
    }
  }
  class AuthenticationError extends APIError {}
  class RateLimitError extends APIError {}
  class APIConnectionError extends APIError {}
  const stream = vi.fn();
  return {
    APIError,
    AuthenticationError,
    RateLimitError,
    APIConnectionError,
    upload: vi.fn(),
    stream,
    countTokens: vi.fn(),
    streamResolve: (message: unknown) =>
      stream.mockImplementation(() => ({ finalMessage: () => Promise.resolve(message) })),
    streamRejectOnce: (error: unknown) =>
      stream.mockImplementationOnce(() => ({ finalMessage: () => Promise.reject(error) })),
  };
});

vi.mock("@anthropic-ai/sdk", () => {
  class Anthropic {
    beta = {
      files: { upload: mocks.upload },
      messages: { stream: mocks.stream, countTokens: mocks.countTokens },
    };
    constructor(_opts?: unknown) {}
    static APIError = mocks.APIError;
    static AuthenticationError = mocks.AuthenticationError;
    static RateLimitError = mocks.RateLimitError;
    static APIConnectionError = mocks.APIConnectionError;
  }
  return { default: Anthropic, toFile: vi.fn(async () => ({ mock: "file" })) };
});

const FILES_BETA = "files-api-2025-04-14";
const PLAN_OUTPUT = {
  outcomeAnalysis: "graded on the final exam",
  tasks: [{ title: "Solve past paper 1", effortMinutes: 25, impact: 5, rationale: "graded", phase: "now" }],
};

let app: express.Express;
let db: Awaited<ReturnType<typeof testDb>>;
let goalId: number;
let pdfMaterialId: number;

/** The document block for the PDF material inside the last stream call. */
function lastPdfSource(): { type: string; file_id?: string } {
  const params = mocks.stream.mock.calls.at(-1)![0] as {
    messages: { content: { type: string; source?: { type: string; file_id?: string } }[] }[];
  };
  const doc = params.messages[0].content.find((b) => b.type === "document");
  return doc!.source!;
}

function lastStreamBetas(): string[] | undefined {
  return (mocks.stream.mock.calls.at(-1)![0] as { betas?: string[] }).betas;
}

/** The document block for the PDF material inside the last count_tokens call. */
function lastCountedPdfSource(): { type: string; data?: string; file_id?: string } {
  const params = mocks.countTokens.mock.calls.at(-1)![0] as {
    messages: { content: { type: string; source?: { type: string; data?: string } }[] }[];
  };
  const doc = params.messages[0].content.find((b) => b.type === "document");
  return doc!.source!;
}

function lastCountBetas(): string[] | undefined {
  return (mocks.countTokens.mock.calls.at(-1)![0] as { betas?: string[] }).betas;
}

function storedFileId(): string | null {
  const row = db.prepare("SELECT anthropic_file_id AS id FROM materials WHERE id = ?").get(pdfMaterialId) as
    | { id: string | null }
    | undefined;
  return row?.id ?? null;
}

beforeAll(async () => {
  app = await freshApp();
  db = await testDb();

  const goal = (await request(app).post("/api/goals").send({ title: "Pass the exam" }).expect(201)).body;
  goalId = goal.id;

  const material = (
    await request(app)
      .post(`/api/goals/${goalId}/materials`)
      .attach("file", Buffer.from("%PDF-1.4 fake exam pdf"), {
        filename: "past-exam.pdf",
        contentType: "application/pdf",
      })
      .expect(201)
  ).body;
  pdfMaterialId = material.id;

  // Dummy key: flips isConfigured() true; every network call is mocked.
  await request(app).put("/api/ai/key").send({ key: "sk-ant-test-dummy" }).expect(200);
});

beforeEach(() => {
  mocks.upload.mockReset();
  mocks.stream.mockReset();
  mocks.countTokens.mockReset();
  // Sensible defaults; individual tests override. count_tokens defaults to
  // the live endpoint's behavior (#138): file sources are REJECTED, anything
  // else counts. A permissive default here is exactly the blindness that let
  // #136's broken estimate gate through CI.
  mocks.countTokens.mockImplementation(async (params: unknown) => {
    if (findFileSource(params)) throw new mocks.APIError(400, COUNT_TOKENS_FILE_SOURCE_ERROR);
    return { input_tokens: 500 };
  });
  mocks.streamResolve({ parsed_output: PLAN_OUTPUT });
  mocks.upload.mockResolvedValue({ id: "file_first" });
  // Each test starts with no cached id so upload behaviour is deterministic.
  db.prepare("UPDATE materials SET anthropic_file_id = NULL WHERE id = ?").run(pdfMaterialId);
});

describe("first AI use uploads the PDF once and references it by file_id", () => {
  it("uploads, stores the id, and sends a file-source document block with the files beta", async () => {
    await request(app)
      .post("/api/ai/plan-goal")
      .send({ goalId, materialIds: [pdfMaterialId] })
      .expect(200);

    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(storedFileId()).toBe("file_first");
    expect(lastPdfSource()).toEqual({ type: "file", file_id: "file_first" });
    expect(lastStreamBetas()).toContain(FILES_BETA);
    // The token guard counts a base64 substitute (#138) — count_tokens rejects
    // file sources — so its request carries no file id and no files beta.
    expect(lastCountedPdfSource().type).toBe("base64");
    expect(lastCountBetas()).toBeUndefined();
  });

  it("reuses the stored id on the next call — no base64, no second upload", async () => {
    // Prime the id as if a prior call had uploaded it.
    db.prepare("UPDATE materials SET anthropic_file_id = 'file_kept' WHERE id = ?").run(pdfMaterialId);

    await request(app)
      .post("/api/ai/plan-goal")
      .send({ goalId, materialIds: [pdfMaterialId] })
      .expect(200);

    expect(mocks.upload).not.toHaveBeenCalled();
    expect(lastPdfSource()).toEqual({ type: "file", file_id: "file_kept" });
  });
});

describe("a rejected file id self-heals with a single re-upload", () => {
  it("clears the dead id, re-uploads from disk, and retries the call once", async () => {
    db.prepare("UPDATE materials SET anthropic_file_id = 'file_dead' WHERE id = ?").run(pdfMaterialId);
    // The paid call rejects the stale id once, then accepts the re-uploaded
    // one. With streaming, the rejection arrives via finalMessage() — exactly
    // where the SDK surfaces request-level errors on a stream.
    mocks.streamRejectOnce(new mocks.APIError(404, "file_dead not found"));
    mocks.upload.mockResolvedValue({ id: "file_reuploaded" });

    await request(app)
      .post("/api/ai/plan-goal")
      .send({ goalId, materialIds: [pdfMaterialId] })
      .expect(200);

    expect(mocks.stream).toHaveBeenCalledTimes(2); // rejected, then retried
    expect(mocks.upload).toHaveBeenCalledTimes(1); // re-upload during the rebuild
    expect(storedFileId()).toBe("file_reuploaded");
    expect(lastPdfSource()).toEqual({ type: "file", file_id: "file_reuploaded" });
  });

  it("does NOT retry an unrelated upstream error", async () => {
    const rateLimited = new mocks.RateLimitError(429, "slow down");
    mocks.stream.mockImplementation(() => ({ finalMessage: () => Promise.reject(rateLimited) }));

    await request(app)
      .post("/api/ai/plan-goal")
      .send({ goalId, materialIds: [pdfMaterialId] })
      .expect(429);
    expect(mocks.stream).toHaveBeenCalledTimes(1); // no retry
  });
});

describe("upload failure falls back to base64 for that call", () => {
  it("sends a base64 document block with no files beta, and stores no id", async () => {
    mocks.upload.mockRejectedValue(new Error("files API unavailable"));

    await request(app)
      .post("/api/ai/plan-goal")
      .send({ goalId, materialIds: [pdfMaterialId] })
      .expect(200);

    expect(lastPdfSource().type).toBe("base64");
    expect(lastStreamBetas()).toBeUndefined();
    expect(storedFileId()).toBeNull(); // a failed upload is not remembered
  });
});

describe("the estimate self-heals a stale id too", () => {
  // Since #138 count_tokens itself never carries a file id, so a live 404
  // from it is unlikely — but the guard still runs while the ASSEMBLY
  // references ids, and the retry policy must keep healing any stale-shaped
  // rejection raised there (upload races, future request shapes).
  it("re-uploads and re-counts when the guard hits a 404 while ids are in play", async () => {
    db.prepare("UPDATE materials SET anthropic_file_id = 'file_dead' WHERE id = ?").run(pdfMaterialId);
    mocks.countTokens
      .mockRejectedValueOnce(new mocks.APIError(404, "file_dead not found"))
      .mockResolvedValueOnce({ input_tokens: 500 });
    mocks.upload.mockResolvedValue({ id: "file_reuploaded" });

    const res = await request(app)
      .post("/api/ai/estimate")
      .send({ goalId, materialIds: [pdfMaterialId] })
      .expect(200);

    expect(res.body.inputTokens).toBe(500);
    expect(mocks.countTokens).toHaveBeenCalledTimes(2);
    expect(storedFileId()).toBe("file_reuploaded");
  });
});

// ---------------------------------------------------------------------------
// #138: the live count_tokens endpoint REJECTS file sources. The guard must
// never send one; a capability 400 must never be classified as a stale id.

describe("count_tokens never sees a file source (#138)", () => {
  // The exact bytes materialBlocks reads from disk for the counting view.
  const PDF_BASE64 = Buffer.from("%PDF-1.4 fake exam pdf").toString("base64");

  it("counts the base64 bytes while the paid call keeps the cached file_id", async () => {
    db.prepare("UPDATE materials SET anthropic_file_id = 'file_kept' WHERE id = ?").run(pdfMaterialId);

    await request(app)
      .post("/api/ai/plan-goal")
      .send({ goalId, materialIds: [pdfMaterialId] })
      .expect(200);

    // Counting view: the id is substituted with the PDF's real bytes...
    expect(lastCountedPdfSource()).toEqual({
      type: "base64",
      media_type: "application/pdf",
      data: PDF_BASE64,
    });
    expect(lastCountBetas()).toBeUndefined();
    // ...while the paid call still references the id, unharmed and uncleared.
    expect(lastPdfSource()).toEqual({ type: "file", file_id: "file_kept" });
    expect(storedFileId()).toBe("file_kept");
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("the estimate counts base64 only — no upload, id untouched", async () => {
    db.prepare("UPDATE materials SET anthropic_file_id = 'file_kept' WHERE id = ?").run(pdfMaterialId);

    const res = await request(app)
      .post("/api/ai/estimate")
      .send({ goalId, materialIds: [pdfMaterialId] })
      .expect(200);

    expect(res.body.inputTokens).toBe(500);
    expect(lastCountedPdfSource().type).toBe("base64");
    expect(mocks.countTokens).toHaveBeenCalledTimes(1); // no retry needed
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(storedFileId()).toBe("file_kept");
  });

  it("the mocked count_tokens rejects a file source exactly like the live endpoint", async () => {
    // The tripwire itself: under this default, the pre-#138 guardTokens —
    // which sent file-source blocks to count_tokens — would 502 every
    // material-backed test in this file instead of passing.
    await expect(
      mocks.countTokens({
        model: "claude-opus-4-8",
        messages: [
          {
            role: "user",
            content: [{ type: "document", source: { type: "file", file_id: "file_x" } }],
          },
        ],
      }),
    ).rejects.toThrow(/File sources are not supported in the token counting endpoint/);
  });
});

describe("a capability 400 is never treated as a stale id (#138)", () => {
  it("surfaces as 502 without invalidating the id or burning an upload", async () => {
    db.prepare("UPDATE materials SET anthropic_file_id = 'file_kept' WHERE id = ?").run(pdfMaterialId);
    // Simulate a capability rejection reaching the guard regardless of shape
    // (the pre-#138 failure: it invalidated the good id, re-uploaded, failed
    // again — one wasted upload and an orphaned file per call).
    mocks.countTokens.mockRejectedValue(new mocks.APIError(400, COUNT_TOKENS_FILE_SOURCE_ERROR));

    const res = await request(app)
      .post("/api/ai/estimate")
      .send({ goalId, materialIds: [pdfMaterialId] })
      .expect(502);

    expect(res.body.error).toMatch(/not supported/);
    expect(mocks.countTokens).toHaveBeenCalledTimes(1); // no retry
    expect(mocks.upload).not.toHaveBeenCalled(); // no burned upload
    expect(storedFileId()).toBe("file_kept"); // id survives
  });
});
