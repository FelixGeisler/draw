import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type express from "express";
import { freshApp, testDb } from "../helpers.js";

// Files API for goal materials (#92, ADR-35). The SDK boundary is mocked so
// the whole aiService path around it runs for real: block assembly, the lazy
// once-per-material upload, the file-id retry, and the base64 fallback. Live
// upload/parse cannot run without a key (setup.ts guarantees degraded mode);
// #91 verifies it against the real API.
//
// The mock is the SDK client, NOT aiService — unlike card-art.test.ts, which
// stubs the whole generateCardArt function. Here the logic under test lives
// inside aiService, so only Anthropic itself is replaced.
const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  parse: vi.fn(),
  countTokens: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => {
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
  class Anthropic {
    beta = {
      files: { upload: mocks.upload },
      messages: { parse: mocks.parse, countTokens: mocks.countTokens },
    };
    constructor(_opts?: unknown) {}
    static APIError = APIError;
    static AuthenticationError = AuthenticationError;
    static RateLimitError = RateLimitError;
    static APIConnectionError = APIConnectionError;
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

/** The document block for the PDF material inside the last parse call. */
function lastPdfSource(): { type: string; file_id?: string } {
  const params = mocks.parse.mock.calls.at(-1)![0] as {
    messages: { content: { type: string; source?: { type: string; file_id?: string } }[] }[];
  };
  const doc = params.messages[0].content.find((b) => b.type === "document");
  return doc!.source!;
}

function lastParseBetas(): string[] | undefined {
  return (mocks.parse.mock.calls.at(-1)![0] as { betas?: string[] }).betas;
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
  mocks.parse.mockReset();
  mocks.countTokens.mockReset();
  // Sensible defaults; individual tests override.
  mocks.countTokens.mockResolvedValue({ input_tokens: 500 });
  mocks.parse.mockResolvedValue({ parsed_output: PLAN_OUTPUT });
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
    expect(lastParseBetas()).toContain(FILES_BETA);
    // The token guard that gates the paid call rides the same beta.
    expect((mocks.countTokens.mock.calls.at(-1)![0] as { betas?: string[] }).betas).toContain(FILES_BETA);
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
    // The paid call rejects the stale id once, then accepts the re-uploaded one.
    const { default: Anthropic } = (await import("@anthropic-ai/sdk")) as unknown as {
      default: { APIError: new (s?: number, m?: string) => Error };
    };
    mocks.parse
      .mockRejectedValueOnce(new Anthropic.APIError(404, "file_dead not found"))
      .mockResolvedValueOnce({ parsed_output: PLAN_OUTPUT });
    mocks.upload.mockResolvedValue({ id: "file_reuploaded" });

    await request(app)
      .post("/api/ai/plan-goal")
      .send({ goalId, materialIds: [pdfMaterialId] })
      .expect(200);

    expect(mocks.parse).toHaveBeenCalledTimes(2); // rejected, then retried
    expect(mocks.upload).toHaveBeenCalledTimes(1); // re-upload during the rebuild
    expect(storedFileId()).toBe("file_reuploaded");
    expect(lastPdfSource()).toEqual({ type: "file", file_id: "file_reuploaded" });
  });

  it("does NOT retry an unrelated upstream error", async () => {
    const { default: Anthropic } = (await import("@anthropic-ai/sdk")) as unknown as {
      default: { RateLimitError: new (s?: number, m?: string) => Error };
    };
    mocks.parse.mockRejectedValue(new Anthropic.RateLimitError(429, "slow down"));

    await request(app)
      .post("/api/ai/plan-goal")
      .send({ goalId, materialIds: [pdfMaterialId] })
      .expect(429);
    expect(mocks.parse).toHaveBeenCalledTimes(1); // no retry
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
    expect(lastParseBetas()).toBeUndefined();
    expect(storedFileId()).toBeNull(); // a failed upload is not remembered
  });
});

describe("the estimate self-heals a stale id too", () => {
  it("re-uploads and re-counts when count_tokens rejects the cached id", async () => {
    db.prepare("UPDATE materials SET anthropic_file_id = 'file_dead' WHERE id = ?").run(pdfMaterialId);
    const { default: Anthropic } = (await import("@anthropic-ai/sdk")) as unknown as {
      default: { APIError: new (s?: number, m?: string) => Error };
    };
    mocks.countTokens
      .mockRejectedValueOnce(new Anthropic.APIError(404, "file_dead not found"))
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
