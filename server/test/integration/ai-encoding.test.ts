import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type express from "express";
import { freshApp } from "../helpers.js";

// #134: the #91 live session saw an em-dash come back as U+FFFD (�) in a
// plan-goal analysis. The server never decodes PDF text itself (PDF bytes
// pass through base64/Files-API untouched — that live corruption traced to
// the session's latin-1-built PDF fixture), but the app DOES own three
// encoding seams, and each is pinned here end to end at the SDK boundary:
//
//   1. .txt/.md material bytes → prompt text (lenient utf-8 read used to
//      inject U+FFFD for every legacy-encoded byte),
//   2. the multipart filename → DB/UI/<material name> (busboy's latin1
//      default mojibake'd UTF-8 filenames),
//   3. the model's response text → HTTP response (must round-trip
//      byte-clean).
const mocks = vi.hoisted(() => {
  const stream = vi.fn();
  return {
    stream,
    countTokens: vi.fn(),
    streamResolve: (message: unknown) =>
      stream.mockImplementation(() => ({ finalMessage: () => Promise.resolve(message) })),
  };
});

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
      files: { upload: vi.fn() },
      messages: { stream: mocks.stream, countTokens: mocks.countTokens },
    };
    constructor(_opts?: unknown) {}
    static APIError = APIError;
    static AuthenticationError = AuthenticationError;
    static RateLimitError = RateLimitError;
    static APIConnectionError = APIConnectionError;
  }
  return { default: Anthropic, toFile: vi.fn(async () => ({ mock: "file" })) };
});

const PLAN_OUTPUT = {
  outcomeAnalysis: "graded on the final exam",
  tasks: [{ title: "Solve past paper 1", effortMinutes: 25, impact: 5, rationale: "graded", phase: "now" }],
};

// "Prüfung — Kapitel 3" in Windows-1252: ü=0xFC, em-dash=0x97 — neither byte
// is valid UTF-8, so a lenient utf-8 read renders both as U+FFFD.
const EXPECTED_TEXT = "Prüfung — Kapitel 3";
const CP1252_BYTES = Buffer.from([
  0x50, 0x72, 0xfc, 0x66, 0x75, 0x6e, 0x67, 0x20, 0x97, 0x20, 0x4b, 0x61, 0x70, 0x69, 0x74,
  0x65, 0x6c, 0x20, 0x33,
]);

let app: express.Express;
let goalId: number;

/** All text blocks of the user message inside the last stream call, joined. */
function lastPromptText(): string {
  const params = mocks.stream.mock.calls.at(-1)![0] as {
    messages: { content: { type: string; text?: string }[] }[];
  };
  return params.messages[0].content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

async function uploadText(filename: string, bytes: Buffer): Promise<number> {
  const res = await request(app)
    .post(`/api/goals/${goalId}/materials`)
    .attach("file", bytes, { filename, contentType: "text/plain" })
    .expect(201);
  return res.body.id as number;
}

beforeAll(async () => {
  app = await freshApp();
  goalId = (await request(app).post("/api/goals").send({ title: "Pass the exam" }).expect(201)).body.id;
  await request(app).put("/api/ai/key").send({ key: "sk-ant-test-dummy" }).expect(200);
});

beforeEach(() => {
  mocks.stream.mockReset();
  mocks.countTokens.mockReset();
  mocks.countTokens.mockResolvedValue({ input_tokens: 500 });
  mocks.streamResolve({ parsed_output: PLAN_OUTPUT });
});

describe("text material bytes reach the prompt UTF-8-clean (#134)", () => {
  it("round-trips a UTF-8 .txt byte-identically — em-dash, umlauts, math symbols", async () => {
    const utf8Content = "Prüfung — Kapitel 3: ≥ 90 % ist nötig, λ ≈ 0,5";
    const id = await uploadText("notes-utf8.txt", Buffer.from(utf8Content, "utf-8"));

    await request(app).post("/api/ai/plan-goal").send({ goalId, materialIds: [id] }).expect(200);

    const prompt = lastPromptText();
    expect(prompt).toContain(utf8Content);
    expect(prompt).not.toContain("�");
  });

  it("transcodes a Windows-1252 .txt instead of injecting U+FFFD", async () => {
    const id = await uploadText("notes-cp1252.txt", CP1252_BYTES);

    await request(app).post("/api/ai/plan-goal").send({ goalId, materialIds: [id] }).expect(200);

    const prompt = lastPromptText();
    expect(prompt).toContain(EXPECTED_TEXT);
    expect(prompt).not.toContain("�");
  });
});

describe("non-ASCII filenames survive upload and request assembly (#134)", () => {
  it("stores the UTF-8 filename, not busboy's latin1 mojibake", async () => {
    const res = await request(app)
      .post(`/api/goals/${goalId}/materials`)
      .attach("file", Buffer.from("Übung eins", "utf-8"), {
        filename: "Übungen—Notizen.txt",
        contentType: "text/plain",
      })
      .expect(201);

    expect(res.body.filename).toBe("Übungen—Notizen.txt");

    // The same name rides into the prompt's <material name="..."> attribute.
    await request(app)
      .post("/api/ai/plan-goal")
      .send({ goalId, materialIds: [res.body.id] })
      .expect(200);
    expect(lastPromptText()).toContain('<material name="Übungen—Notizen.txt">');
  });
});

describe("model response text reaches the HTTP client byte-clean (#134)", () => {
  it("returns non-ASCII analysis text exactly as the model produced it", async () => {
    const analysis = "…the Baumgartner bakery — the highest-value topic (≥ 40 % der Punkte, „Prüfung“)";
    mocks.streamResolve({ parsed_output: { ...PLAN_OUTPUT, outcomeAnalysis: analysis } });

    const res = await request(app).post("/api/ai/plan-goal").send({ goalId }).expect(200);

    expect(res.body.outcomeAnalysis).toBe(analysis);
    expect(JSON.stringify(res.body)).not.toContain("�");
  });
});
