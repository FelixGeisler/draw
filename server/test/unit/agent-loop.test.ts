import { describe, expect, it } from "vitest";
import {
  addUsage,
  runAgentLoop,
  usageUsd,
  zeroUsage,
  type LoopMessage,
  type ModelTurn,
} from "../../src/services/agentLoop.js";

// The loop with an injected fake runner (#31 acceptance criterion): budget
// and iteration aborts return the partial state with a stopped reason, tool
// results are always appended before an abort, and cost accounting includes
// OUTPUT tokens (the issue's explicit trap: input-only pricing would
// understate agent runs badly).

const usage = (input = 100, output = 50) => ({ input_tokens: input, output_tokens: output });

function textTurn(text: string): ModelTurn {
  return { content: [{ type: "text", text }], stopReason: "end_turn", usage: usage() };
}

function toolTurn(name: string, input: unknown, id = "tool-1"): ModelTurn {
  return {
    content: [
      { type: "text", text: "calling a tool" },
      { type: "tool_use", id, name, input },
    ],
    stopReason: "tool_use",
    usage: usage(),
  };
}

function deps(turns: ModelTurn[], overrides: Record<string, unknown> = {}) {
  const toolCalls: { name: string; input: unknown }[] = [];
  let i = 0;
  return {
    toolCalls,
    deps: {
      callModel: async () => {
        if (i >= turns.length) throw new Error("fake model exhausted");
        return turns[i++];
      },
      runTool: async (name: string, input: unknown) => {
        toolCalls.push({ name, input });
        return { text: `result of ${name}` };
      },
      maxIterations: 8,
      budgetUsd: 100,
      ...overrides,
    },
  };
}

describe("runAgentLoop", () => {
  it("returns the final text when the model stops without tool use", async () => {
    const messages: LoopMessage[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    const { deps: d } = deps([textTurn("hello there")]);
    const result = await runAgentLoop(messages, d);
    expect(result.reply).toBe("hello there");
    expect(result.stopped).toBeUndefined();
    expect(result.iterations).toBe(1);
    // history grew by the assistant turn
    expect(messages).toHaveLength(2);
  });

  it("executes tool calls, feeds results back as one user message, and loops", async () => {
    const messages: LoopMessage[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
    const { deps: d, toolCalls } = deps([
      toolTurn("list_tasks", { status: "open" }),
      textTurn("done"),
    ]);
    const result = await runAgentLoop(messages, d);
    expect(toolCalls).toEqual([{ name: "list_tasks", input: { status: "open" } }]);
    expect(result.reply).toBe("done");
    // user, assistant(tool_use), user(tool_result), assistant(final)
    expect(messages).toHaveLength(4);
    const toolResultMsg = messages[2];
    expect(toolResultMsg.role).toBe("user");
    expect((toolResultMsg.content as { type: string }[])[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tool-1",
      content: "result of list_tasks",
    });
  });

  it("runs all parallel tool calls of one turn and returns all results in one message", async () => {
    const messages: LoopMessage[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
    const turn: ModelTurn = {
      content: [
        { type: "tool_use", id: "a", name: "list_goals", input: {} },
        { type: "tool_use", id: "b", name: "list_categories", input: {} },
      ],
      stopReason: "tool_use",
      usage: usage(),
    };
    const { deps: d, toolCalls } = deps([turn, textTurn("ok")]);
    await runAgentLoop(messages, d);
    expect(toolCalls.map((c) => c.name)).toEqual(["list_goals", "list_categories"]);
    expect((messages[2].content as unknown[]).length).toBe(2);
  });

  it("aborts at the iteration cap with the partial state and a valid history", async () => {
    const messages: LoopMessage[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
    const endless = Array.from({ length: 3 }, (_, i) => toolTurn("list_tasks", {}, `t${i}`));
    const { deps: d } = deps(endless, { maxIterations: 3 });
    const result = await runAgentLoop(messages, d);
    expect(result.stopped).toBe("max_iterations");
    expect(result.iterations).toBe(3);
    // Every tool_use got its tool_result appended — no dangling call.
    const last = messages[messages.length - 1];
    expect(last.role).toBe("user");
    expect((last.content as { type: string }[])[0].type).toBe("tool_result");
  });

  it("aborts on the token budget after appending the pending tool results", async () => {
    const messages: LoopMessage[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
    // One iteration costs 100 input + 50 output tokens = 0.0005 + 0.00125 USD.
    const { deps: d } = deps([toolTurn("list_tasks", {}), toolTurn("list_tasks", {}, "t2")], {
      budgetUsd: 0.001, // crossed by the very first iteration's OUTPUT cost
    });
    const result = await runAgentLoop(messages, d);
    expect(result.stopped).toBe("token_budget");
    expect(result.iterations).toBe(1);
    expect((messages[messages.length - 1].content as { type: string }[])[0].type).toBe("tool_result");
  });

  it("accumulates usage across iterations", async () => {
    const messages: LoopMessage[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
    const { deps: d } = deps([toolTurn("list_tasks", {}), textTurn("ok")]);
    const result = await runAgentLoop(messages, d);
    expect(result.usage.inputTokens).toBe(200);
    expect(result.usage.outputTokens).toBe(100);
  });

  it("answers a truncated turn's tool calls with synthetic error results instead of executing them", async () => {
    // stop_reason "max_tokens" with tool_use blocks still present: the 16K
    // budget is shared with adaptive thinking, so a live turn can be cut off
    // mid-tool-call. Executing possibly-truncated inputs is forbidden; every
    // dangling tool_use must still get a tool_result or the session is dead.
    const messages: LoopMessage[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
    const truncated: ModelTurn = {
      content: [
        { type: "text", text: "partial reply" },
        { type: "tool_use", id: "cut-1", name: "create_task", input: {} },
        { type: "tool_use", id: "cut-2", name: "create_task", input: {} },
      ],
      stopReason: "max_tokens",
      usage: usage(),
    };
    const { deps: d, toolCalls } = deps([truncated]);
    const result = await runAgentLoop(messages, d);

    expect(result.stopped).toBe("truncated");
    expect(result.reply).toBe("partial reply");
    expect(toolCalls).toHaveLength(0); // nothing executed
    // ALL dangling tool_use ids answered, in ONE user message, as errors.
    const last = messages[messages.length - 1];
    expect(last.role).toBe("user");
    const blocks = last.content as { type: string; tool_use_id: string; is_error?: boolean; content: string }[];
    expect(blocks.map((b) => [b.type, b.tool_use_id, b.is_error])).toEqual([
      ["tool_result", "cut-1", true],
      ["tool_result", "cut-2", true],
    ]);
    expect(blocks[0].content).toMatch(/max_tokens/);
  });

  it("leaves an API-legal history after truncation — the next send succeeds", async () => {
    const messages: LoopMessage[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
    const truncated: ModelTurn = {
      content: [{ type: "tool_use", id: "cut", name: "list_tasks", input: {} }],
      stopReason: "max_tokens",
      usage: usage(),
    };
    const { deps: d1 } = deps([truncated]);
    await runAgentLoop(messages, d1);

    // Follow-up send on the same session history.
    messages.push({ role: "user", content: [{ type: "text", text: "continue" }] });
    const { deps: d2 } = deps([textTurn("resumed")]);
    const result = await runAgentLoop(messages, d2);
    expect(result.reply).toBe("resumed");

    // The structural invariant the API enforces: every tool_use id in an
    // assistant turn has a matching tool_result in the following user turn.
    const useIds: string[] = [];
    const resultIds: string[] = [];
    for (const m of messages) {
      if (!Array.isArray(m.content)) continue;
      for (const block of m.content as { type: string; id?: string; tool_use_id?: string }[]) {
        if (block.type === "tool_use") useIds.push(block.id!);
        if (block.type === "tool_result") resultIds.push(block.tool_use_id!);
      }
    }
    expect(resultIds.sort()).toEqual(useIds.sort());
  });
});

describe("usage accounting", () => {
  it("prices output tokens at 25 USD/MTok — 5× input — and includes cache reads/writes", () => {
    const u = zeroUsage();
    addUsage(u, {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
    });
    expect(usageUsd(u)).toBeCloseTo(5 + 25 + 0.5 + 6.25, 10);
  });

  it("treats absent cache fields as zero", () => {
    const u = zeroUsage();
    addUsage(u, { input_tokens: 10, output_tokens: 10 });
    expect(u.cacheReadInputTokens).toBe(0);
    expect(u.cacheCreationInputTokens).toBe(0);
  });
});
