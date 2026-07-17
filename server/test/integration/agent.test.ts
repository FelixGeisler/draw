import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type express from "express";
import { COUNT_TOKENS_FILE_SOURCE_ERROR, findFileSource, freshApp } from "../helpers.js";

// The assistant's message loop and apply step (#31, ADR-37), tested at the
// #136 convention: the Anthropic SDK is mocked at the stream()/finalMessage()
// seam (ADR-36 — the suite never mocks Anthropic's network, and never calls
// it), everything below — the loop, staging, the in-process read tools, the
// apply transaction through the real route cores — runs for real against
// this file's own database.

const mocks = vi.hoisted(() => {
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
    stream,
    countTokens: vi.fn(),
    /** Queue one model turn: the next stream() call resolves to this message. */
    turn: (content: unknown[], stopReason = "end_turn", usage: Record<string, number> = {}) =>
      stream.mockImplementationOnce(() => ({
        finalMessage: () =>
          Promise.resolve({
            content,
            stop_reason: stopReason,
            usage: { input_tokens: 1_000, output_tokens: 500, ...usage },
          }),
      })),
  };
});

vi.mock("@anthropic-ai/sdk", () => {
  class Anthropic {
    beta = {
      files: { upload: vi.fn() },
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

let app: express.Express;
let goalId: number;

async function taskCount(): Promise<number> {
  const res = await request(app).get("/api/tasks?status=all").expect(200);
  return res.body.reduce(
    (n: number, root: { subtasks: unknown[] }) => n + 1 + root.subtasks.length,
    0,
  );
}

beforeAll(async () => {
  app = await freshApp();
  goalId = (await request(app).post("/api/goals").send({ title: "Pass the exam" }).expect(201)).body
    .id;
  await request(app)
    .post("/api/tasks")
    .send({ title: "Seeded existing task", categoryId: 1, effortMinutes: 10 })
    .expect(201);
  // Dummy key: flips isConfigured() true; every network call is mocked.
  await request(app).put("/api/ai/key").send({ key: "sk-ant-test-dummy" }).expect(200);
});

beforeEach(async () => {
  mocks.stream.mockReset();
  mocks.countTokens.mockReset();
  // Strict like the live endpoint (#138): file-source blocks are rejected.
  mocks.countTokens.mockImplementation(async (params: unknown) => {
    if (findFileSource(params)) throw new mocks.APIError(400, COUNT_TOKENS_FILE_SOURCE_ERROR);
    return { input_tokens: 500 };
  });
  const { resetAgentSessions } = await import("../../src/services/agentService.js");
  resetAgentSessions();
});

interface StreamParams {
  model: string;
  max_tokens: number;
  thinking: { type: string };
  system: string;
  tools: { name: string }[];
  messages: { role: string; content: unknown }[];
}

function streamParams(call: number): StreamParams {
  return mocks.stream.mock.calls[call][0] as StreamParams;
}

/** The first tool_result block in a request's history. */
function findToolResult(params: StreamParams): { is_error?: boolean; content: string } {
  for (const msg of params.messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as { type: string; is_error?: boolean; content: string }[]) {
      if (block.type === "tool_result") return block;
    }
  }
  throw new Error("no tool_result in the captured request");
}

describe("the agent message loop", () => {
  it("stages creates without writing — task count is unchanged after the turn", async () => {
    const before = await taskCount();
    mocks.turn(
      [
        {
          type: "tool_use",
          id: "t1",
          name: "create_task",
          input: { title: "Read chapter 1", categoryId: 1, effortMinutes: 25 },
        },
      ],
      "tool_use",
    );
    mocks.turn([{ type: "text", text: "I staged one task for your review." }]);

    const res = await request(app)
      .post("/api/ai/agent/message")
      .send({ message: "add a reading task" })
      .expect(200);

    expect(await taskCount()).toBe(before); // THE core invariant: no mid-loop writes
    expect(res.body.reply).toBe("I staged one task for your review.");
    expect(res.body.sessionId).toBeTruthy();
    expect(res.body.changeset.ops).toHaveLength(1);
    expect(res.body.changeset.ops[0]).toMatchObject({
      kind: "create_task",
      draftId: "draft-1",
      task: { title: "Read chapter 1", effortMinutes: 25 },
    });
  });

  it("pins the streamed request shape: model, adaptive thinking, staged-tool vocabulary (ADR-36)", async () => {
    mocks.turn([{ type: "text", text: "hi" }]);
    await request(app).post("/api/ai/agent/message").send({ message: "hello" }).expect(200);

    const params = streamParams(0);
    expect(params.model).toBe("claude-opus-4-8");
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.system).toMatch(/stage DRAFTS/);
    expect(params.tools.map((t) => t.name).sort()).toEqual([
      "create_subtasks",
      "create_task",
      "get_settings",
      "get_stats",
      "list_categories",
      "list_goals",
      "list_tasks",
    ]);
  });

  it("executes read tools LIVE against the app's own API and feeds results back", async () => {
    mocks.turn([{ type: "tool_use", id: "t1", name: "list_tasks", input: {} }], "tool_use");
    mocks.turn([{ type: "text", text: "you have tasks" }]);

    await request(app).post("/api/ai/agent/message").send({ message: "what do I have?" }).expect(200);

    // The second model call carries the tool_result with the REAL task list.
    // (The captured messages array is the live session history — scan for the
    // tool_result rather than indexing from the end.)
    const toolResult = findToolResult(streamParams(1));
    expect(toolResult.content).toContain("Seeded existing task");
  });

  it("returns staging errors to the model as tool errors, not as HTTP failures", async () => {
    mocks.turn(
      [{ type: "tool_use", id: "t1", name: "create_task", input: { title: "x", categoryId: 999 } }],
      "tool_use",
    );
    mocks.turn([{ type: "text", text: "corrected" }]);

    const res = await request(app).post("/api/ai/agent/message").send({ message: "go" }).expect(200);
    expect(res.body.changeset.ops).toHaveLength(0);
    const result = findToolResult(streamParams(1));
    expect(result.is_error).toBe(true);
    expect(result.content).toMatch(/list_categories/);
  });

  it("aborts at the iteration cap with stopped: max_iterations and the partial changeset", async () => {
    // The model never stops asking for tools; unique titles avoid confusion.
    let n = 0;
    mocks.stream.mockImplementation(() => ({
      finalMessage: () =>
        Promise.resolve({
          content: [
            {
              type: "tool_use",
              id: `t${n}`,
              name: "create_task",
              input: { title: `Task ${n++}`, categoryId: 1 },
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
    }));

    const res = await request(app).post("/api/ai/agent/message").send({ message: "go" }).expect(200);
    expect(res.body.stopped).toBe("max_iterations");
    expect(mocks.stream).toHaveBeenCalledTimes(8);
    expect(res.body.changeset.ops).toHaveLength(8); // partial work survives for review
    expect(res.body.reply).toMatch(/iteration cap/);
  });

  it("aborts on the token budget, pricing OUTPUT tokens at 25 USD/MTok", async () => {
    // One turn of 40K in / 55K out ≈ 0.2 + 1.375 USD — over the 1.5 budget
    // only because output is priced correctly; input-only pricing would sail
    // through the cap and the second mocked turn would run.
    mocks.turn(
      [{ type: "tool_use", id: "t1", name: "list_tasks", input: {} }],
      "tool_use",
      { input_tokens: 40_000, output_tokens: 55_000 },
    );
    mocks.turn([{ type: "text", text: "should never run" }]);

    const res = await request(app).post("/api/ai/agent/message").send({ message: "go" }).expect(200);
    expect(res.body.stopped).toBe("token_budget");
    expect(mocks.stream).toHaveBeenCalledTimes(1);
    expect(res.body.usage).toMatchObject({ inputTokens: 40_000, outputTokens: 55_000 });
    expect(res.body.usage.estimatedUsd).toBeCloseTo(1.575, 3);
  });

  it("continues a session by id and 404s an unknown one", async () => {
    mocks.turn([{ type: "text", text: "first" }]);
    const first = await request(app).post("/api/ai/agent/message").send({ message: "one" }).expect(200);

    mocks.turn([{ type: "text", text: "second" }]);
    await request(app)
      .post("/api/ai/agent/message")
      .send({ sessionId: first.body.sessionId, message: "two" })
      .expect(200);
    // The follow-up request carried the full history: first user turn, first
    // assistant reply, then the follow-up. (The captured array is the live
    // session history, so it also holds turns appended after the call.)
    const params = streamParams(1);
    expect(params.messages.length).toBeGreaterThanOrEqual(3);
    expect(params.messages.slice(0, 3).map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(params.messages[2].content)).toContain("two");

    const missing = await request(app)
      .post("/api/ai/agent/message")
      .send({ sessionId: "not-a-session", message: "hello" })
      .expect(404);
    expect(missing.body.error).toMatch(/start a new conversation/);
  });

  it("reports the estimate for the first send (input-only pricing, like the other gates)", async () => {
    const res = await request(app)
      .post("/api/ai/agent/estimate")
      .send({ goalId, message: "import my exam" })
      .expect(200);
    expect(res.body.inputTokens).toBe(500);
    // Rounded to mils, the estimate() convention: 500 tokens × $5/MTok = $0.0025 → 0.003.
    expect(res.body.estimatedUsd).toBe(0.003);
    expect(mocks.stream).not.toHaveBeenCalled(); // estimating never runs the loop
  });
});

describe("the apply step", () => {
  it("creates accepted ops in one transaction, resolving draft parents to real ids", async () => {
    const res = await request(app)
      .post("/api/ai/agent/apply")
      .send({
        operations: [
          {
            kind: "create_task",
            draftId: "draft-1",
            task: { title: "Exam import umbrella", categoryId: 1, goalId },
          },
          {
            kind: "create_subtasks",
            draftId: "draft-2",
            parentId: "draft-1",
            subtasks: [
              { draftId: "draft-3", title: "Solve exercise 1", effortMinutes: 20, impact: 4 },
              { draftId: "draft-4", title: "Solve exercise 2", effortMinutes: 25, impact: 5 },
            ],
          },
        ],
      })
      .expect(201);

    const byDraft = new Map<string, number[]>(
      res.body.created.map((c: { draftId: string; taskIds: number[] }) => [c.draftId, c.taskIds]),
    );
    const parentId = byDraft.get("draft-1")![0];
    const tasks = await request(app).get(`/api/tasks?goalId=${goalId}`).expect(200);
    const parent = tasks.body.find((t: { id: number }) => t.id === parentId);
    expect(parent.title).toBe("Exam import umbrella");
    expect(parent.subtasks).toHaveLength(2);
    expect(parent.subtasks.map((s: { id: number }) => s.id).sort()).toEqual(
      [...byDraft.get("draft-3")!, ...byDraft.get("draft-4")!].sort(),
    );
    // Subtasks inherit the parent's goal — the route core's rule, untouched.
    expect(parent.subtasks[0].goalId).toBe(goalId);
    expect(parent.subtasks[0].impact).toBe(4);
  });

  it("is atomic: an invalid categoryId in a later op rolls back the WHOLE changeset", async () => {
    const before = await taskCount();
    const res = await request(app)
      .post("/api/ai/agent/apply")
      .send({
        operations: [
          { kind: "create_task", draftId: "draft-1", task: { title: "would be created", categoryId: 1 } },
          { kind: "create_task", draftId: "draft-2", task: { title: "bad category", categoryId: 999 } },
        ],
      })
      .expect(400);
    expect(res.body.error).toMatch(/draft-2/);
    expect(res.body.error).toMatch(/category not found/);
    expect(await taskCount()).toBe(before); // draft-1 rolled back too
  });

  it("enforces the ADR-4 impact gate through the same core the route runs", async () => {
    const before = await taskCount();
    const res = await request(app)
      .post("/api/ai/agent/apply")
      .send({
        operations: [
          { kind: "create_task", draftId: "draft-1", task: { title: "goal-less 5★", categoryId: 1, impact: 5 } },
        ],
      })
      .expect(400);
    expect(res.body.error).toMatch(/ADR-4/);
    expect(await taskCount()).toBe(before);
  });

  it("splits an oversized effort into parts preserving the total — never clamps (#28 policy)", async () => {
    const res = await request(app)
      .post("/api/ai/agent/apply")
      .send({
        operations: [
          { kind: "create_task", draftId: "draft-1", task: { title: "Split parent", categoryId: 1 } },
          {
            kind: "create_subtasks",
            draftId: "draft-2",
            parentId: "draft-1",
            // The reviewer raised the effort after staging — apply re-splits.
            subtasks: [{ draftId: "draft-3", title: "Long proof", effortMinutes: 75 }],
          },
        ],
      })
      .expect(201);

    const split = res.body.created.find((c: { draftId: string }) => c.draftId === "draft-3");
    expect(split.taskIds).toHaveLength(3); // ceil(75 / 30) at the default max_draw_effort
    const parentId = res.body.created.find((c: { draftId: string }) => c.draftId === "draft-1")
      .taskIds[0];
    const tasks = await request(app).get("/api/tasks").expect(200);
    const parent = tasks.body.find((t: { id: number }) => t.id === parentId);
    const minutes = parent.subtasks.map((s: { effortMinutes: number }) => s.effortMinutes);
    expect(minutes.reduce((a: number, b: number) => a + b, 0)).toBe(75);
    expect(Math.max(...minutes)).toBeLessThanOrEqual(30);
    expect(parent.subtasks[0].title).toBe("Long proof (part 1/3)");
  });

  it("rejects a plan whose draft parent is not applied — deselecting a parent deselects children", async () => {
    const res = await request(app)
      .post("/api/ai/agent/apply")
      .send({
        operations: [
          {
            kind: "create_subtasks",
            draftId: "draft-2",
            parentId: "draft-1", // create_task draft-1 was deselected in review
            subtasks: [{ draftId: "draft-3", title: "orphan" }],
          },
        ],
      })
      .expect(400);
    expect(res.body.error).toMatch(/draft-1/);
  });

  it("clears the session's staged changeset after an apply that names the session", async () => {
    mocks.turn(
      [{ type: "tool_use", id: "t1", name: "create_task", input: { title: "Staged row", categoryId: 1 } }],
      "tool_use",
    );
    mocks.turn([{ type: "text", text: "staged" }]);
    const first = await request(app).post("/api/ai/agent/message").send({ message: "go" }).expect(200);
    expect(first.body.changeset.ops).toHaveLength(1);

    await request(app)
      .post("/api/ai/agent/apply")
      .send({ sessionId: first.body.sessionId, operations: first.body.changeset.ops })
      .expect(201);

    mocks.turn([{ type: "text", text: "anything else?" }]);
    const second = await request(app)
      .post("/api/ai/agent/message")
      .send({ sessionId: first.body.sessionId, message: "thanks" })
      .expect(200);
    expect(second.body.changeset.ops).toHaveLength(0); // applied ops are not re-proposed
  });
});
