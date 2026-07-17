/**
 * The assistant's tool-use loop (#31, ADR-37) — pure orchestration: the model
 * transport, the tool executors and the caps are injected, so the whole
 * budget/abort behavior is unit-testable without the SDK. agentService binds
 * `callModel` to a streamed `beta.messages.stream()` request (ADR-36: every
 * AI call streams) and `runTool` to the catalog reads + staging writes.
 *
 * The manual while-stop_reason-is-tool_use loop is deliberate (the issue's
 * documented fallback, promoted to primary): the per-iteration usage the
 * budget needs is exactly what the SDK's beta toolRunner abstracts away, and
 * the manual loop keeps the SDK boundary on the same stream()/finalMessage()
 * seam the whole test suite already pins (#133/#136 convention).
 */

// Minimal structural block types — the loop passes content through verbatim
// (thinking blocks included: adaptive thinking requires echoing them back
// unchanged), it only INSPECTS text and tool_use blocks.
export interface TextBlock {
  type: "text";
  text: string;
}
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
export type LoopBlock = TextBlock | ToolUseBlock | { type: string; [k: string]: unknown };

export interface LoopMessage {
  role: "user" | "assistant";
  content: LoopBlock[] | string;
}

export interface SdkUsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export interface ModelTurn {
  content: LoopBlock[];
  stopReason: string | null;
  usage: SdkUsageLike;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export function zeroUsage(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
}

export function addUsage(total: AgentUsage, turn: SdkUsageLike): void {
  total.inputTokens += turn.input_tokens ?? 0;
  total.outputTokens += turn.output_tokens ?? 0;
  total.cacheReadInputTokens += turn.cache_read_input_tokens ?? 0;
  total.cacheCreationInputTokens += turn.cache_creation_input_tokens ?? 0;
}

// claude-opus-4-8 pricing, USD per MTok. Output at 25 is the number the
// issue calls out: the pre-existing estimate() prices INPUT only and would
// understate an agent run by the entire completion side. Cache reads bill at
// 0.1× input, cache writes at 1.25×.
export const INPUT_USD_PER_MTOK = 5;
export const OUTPUT_USD_PER_MTOK = 25;
export const CACHE_READ_USD_PER_MTOK = 0.5;
export const CACHE_WRITE_USD_PER_MTOK = 6.25;

/** Actual cost of the accumulated usage, in USD (not rounded — display rounds). */
export function usageUsd(u: AgentUsage): number {
  return (
    (u.inputTokens * INPUT_USD_PER_MTOK +
      u.outputTokens * OUTPUT_USD_PER_MTOK +
      u.cacheReadInputTokens * CACHE_READ_USD_PER_MTOK +
      u.cacheCreationInputTokens * CACHE_WRITE_USD_PER_MTOK) /
    1_000_000
  );
}

export type LoopStopReason = "max_iterations" | "token_budget" | "truncated";

// Per-user-message caps (the issue's guardrails): at most 8 model round
// trips, and a hard cost ceiling summed from per-iteration usage. An abort
// returns the partial changeset plus an explanation instead of an error —
// the staged work survives review.
export const AGENT_MAX_ITERATIONS = 8;
export const AGENT_TURN_BUDGET_USD = 1.5;

export interface LoopResult {
  /** Text of the final assistant message ("" when the loop was cut off mid-tool-use). */
  reply: string;
  usage: AgentUsage;
  iterations: number;
  stopped?: LoopStopReason;
}

export interface LoopDeps {
  /** One model round trip over the full message history (streams inside). */
  callModel(messages: LoopMessage[]): Promise<ModelTurn>;
  /** Execute one tool call (live read or staged write). Never throws — errors come back as isError outcomes. */
  runTool(name: string, input: unknown): Promise<{ text: string; isError?: boolean }>;
  /** Hard cap on model round trips per user message. */
  maxIterations: number;
  /** Abort once the turn's accumulated cost crosses this (checked between iterations). */
  budgetUsd: number;
}

function textOf(content: LoopBlock[]): string {
  return content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * Run the loop over `messages`, which is MUTATED in place (it is the
 * session's history: assistant turns and tool results must survive the turn
 * so the conversation can continue). EVERY tool_use is answered with a
 * tool_result before the loop returns — the loop's own aborts append the real
 * results, and a model-side truncation gets synthetic error results — so the
 * history is never left with a dangling tool_use and the next user message
 * continues a valid conversation.
 */
export async function runAgentLoop(messages: LoopMessage[], deps: LoopDeps): Promise<LoopResult> {
  const usage = zeroUsage();
  let iterations = 0;
  let lastText = "";

  for (;;) {
    if (iterations >= deps.maxIterations) {
      return { reply: lastText, usage, iterations, stopped: "max_iterations" };
    }
    iterations++;

    const turn = await deps.callModel(messages);
    addUsage(usage, turn.usage);
    messages.push({ role: "assistant", content: turn.content });
    lastText = textOf(turn.content) || lastText;

    const toolUses = turn.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) {
      return { reply: textOf(turn.content), usage, iterations };
    }

    if (turn.stopReason !== "tool_use") {
      // A model-side truncation (stop_reason "max_tokens" — the 16K cap is
      // shared with adaptive thinking) can cut a turn off while it still
      // carries tool_use blocks. Executing them would act on possibly
      // incomplete arguments, and dropping them would leave dangling
      // tool_use ids the API rejects on EVERY further send in this session.
      // Synthetic error results keep the history API-legal and the model's
      // context honest: the next turn sees that nothing ran, and why.
      const aborted: LoopBlock[] = toolUses.map((use) => ({
        type: "tool_result",
        tool_use_id: use.id,
        content: `not executed — the turn was cut off (stop_reason: ${turn.stopReason})`,
        is_error: true,
      }));
      messages.push({ role: "user", content: aborted });
      return { reply: lastText, usage, iterations, stopped: "truncated" };
    }

    // All results go back in ONE user message (parallel tool-use contract).
    const results: LoopBlock[] = [];
    for (const use of toolUses) {
      const outcome = await deps.runTool(use.name, use.input);
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: outcome.text,
        ...(outcome.isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: "user", content: results });

    if (usageUsd(usage) >= deps.budgetUsd) {
      return { reply: lastText, usage, iterations, stopped: "token_budget" };
    }
  }
}
