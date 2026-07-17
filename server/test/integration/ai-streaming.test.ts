import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type express from "express";
import { freshApp } from "../helpers.js";

// #133: the SDK refuses a NON-streaming request whose max_tokens implies a
// possible >10-minute run — generate-tasks' 32K cap tripped that guard on the
// first-ever real call (#91) and 500'd the flagship exam import while every
// mocked test stayed green. Since then, ALL structured AI calls go through
// `messages.stream()` + finalMessage(). This suite pins the streaming request
// shape at the SDK boundary (the repo's #136 convention: mock Anthropic
// itself, run the whole aiService path for real) so a regression back to the
// non-streaming parse() — or a cap raise that would re-trip the guard on a
// non-streamed call — fails loudly here instead of live.
//
// The live 32K path itself still cannot run without a key; its re-verification
// is on #91's checklist.
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
      // No `parse` on purpose: the streaming migration is total. If any code
      // path reaches for messages.parse() again, it explodes right here.
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

const GENERATE_OUTPUT = {
  sourceOverview: "A past exam with 2 exercises.",
  tasks: [
    {
      label: "1",
      title: "Solve exercise 1 on matrices",
      points: 10,
      statedMinutes: 20,
      estimatedMinutes: 20,
      suggestedImpact: 5,
      rationale: "Ex. 1, 10 pts, 20 min per the PDF",
      parts: [],
    },
    {
      label: "2",
      title: "Write the proof for exercise 2",
      points: 5,
      statedMinutes: null,
      estimatedMinutes: 15,
      suggestedImpact: 4,
      rationale: "Ex. 2, 5 pts",
      parts: [],
    },
  ],
};

const PLAN_OUTPUT = {
  outcomeAnalysis: "graded on the final exam",
  tasks: [{ title: "Solve past paper 1", effortMinutes: 25, impact: 5, rationale: "graded", phase: "now" }],
};

const BREAKDOWN_OUTPUT = {
  subtasks: [{ title: "Open the document", effortMinutes: 5, impact: 3, rationale: "starter" }],
  approachNote: "start small",
  orderMatters: false,
};

interface StreamParams {
  model: string;
  max_tokens: number;
  stream?: boolean;
  thinking: { type: string };
  system: string;
  output_config?: { format?: { type: string } };
  messages: { role: string }[];
}

function lastStreamParams(): StreamParams {
  return mocks.stream.mock.calls.at(-1)![0] as StreamParams;
}

let app: express.Express;
let goalId: number;
let taskId: number;

beforeAll(async () => {
  app = await freshApp();

  goalId = (await request(app).post("/api/goals").send({ title: "Pass the exam" }).expect(201)).body.id;
  taskId = (
    await request(app)
      .post("/api/tasks")
      .send({ title: "Prepare the exam summary", categoryId: 1, effortMinutes: 120 })
      .expect(201)
  ).body.id;

  // Dummy key: flips isConfigured() true; every network call is mocked.
  await request(app).put("/api/ai/key").send({ key: "sk-ant-test-dummy" }).expect(200);
});

beforeEach(() => {
  mocks.stream.mockReset();
  mocks.countTokens.mockReset();
  mocks.countTokens.mockResolvedValue({ input_tokens: 500 });
});

describe("generate-tasks rides the streaming API (#133)", () => {
  it("streams with the raised 32K cap, transcription prompt and structured output format", async () => {
    mocks.streamResolve({ parsed_output: GENERATE_OUTPUT });

    const res = await request(app)
      .post("/api/ai/generate-tasks")
      .send({ goalId, instruction: "transcribe every exercise" })
      .expect(200);

    expect(mocks.stream).toHaveBeenCalledTimes(1);
    const params = lastStreamParams();
    // The exact shape whose non-streaming form the SDK refuses (>10-min guard).
    expect(params.max_tokens).toBe(32_000);
    expect(params.model).toBe("claude-opus-4-8");
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.system).toContain("transcription engine");
    // Structured outputs still ride along: zod schema as json_schema format.
    expect(params.output_config?.format?.type).toBe("json_schema");
    // The helper owns stream mode — the params must not force it off.
    expect(params.stream).not.toBe(false);

    // The parsed result flows through post-processing to the client untouched.
    expect(res.body.tasks).toHaveLength(2);
    expect(res.body.tasks[0].title).toBe("Solve exercise 1 on matrices");
  });
});

describe("the other structured calls stream too — no non-streaming call can outgrow the guard", () => {
  it("plan-goal streams with the 16K default and the planning prompt", async () => {
    mocks.streamResolve({ parsed_output: PLAN_OUTPUT });

    await request(app).post("/api/ai/plan-goal").send({ goalId }).expect(200);

    const params = lastStreamParams();
    expect(params.max_tokens).toBe(16_000);
    expect(params.system).toContain("planning brain");
    expect(params.output_config?.format?.type).toBe("json_schema");
  });

  it("breakdown streams with the 16K default", async () => {
    mocks.streamResolve({ parsed_output: BREAKDOWN_OUTPUT });

    await request(app).post("/api/ai/breakdown").send({ taskId }).expect(200);

    expect(mocks.stream).toHaveBeenCalledTimes(1);
    expect(lastStreamParams().max_tokens).toBe(16_000);
  });
});

describe("streamed error/parse behavior matches the old parse() contract", () => {
  it("maps a null parsed_output on the final message to a 502", async () => {
    mocks.streamResolve({ parsed_output: null });

    const res = await request(app).post("/api/ai/plan-goal").send({ goalId }).expect(502);
    expect(res.body.error).toMatch(/unparseable/);
  });

  it("maps a request-level SDK error rejecting finalMessage() to a 502", async () => {
    const { default: Anthropic } = (await import("@anthropic-ai/sdk")) as unknown as {
      default: { APIError: new (s?: number, m?: string) => Error };
    };
    mocks.stream.mockImplementation(() => ({
      finalMessage: () => Promise.reject(new Anthropic.APIError(500, "overloaded")),
    }));

    await request(app).post("/api/ai/plan-goal").send({ goalId }).expect(502);
  });
});
