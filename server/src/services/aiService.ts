import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ZodType } from "zod";
import fs from "node:fs";
import path from "node:path";
import { API_KEY_SETTING, db, filesDir, getSetting, getSettingString } from "../db.js";
import {
  breakdownSchema,
  generateTasksSchema,
  planGoalSchema,
  type BreakdownResult,
  type PlanGoalResult,
} from "../aiSchemas.js";
import {
  MAX_ITEMS,
  MAX_PARTS_PER_ITEM,
  postprocessGenerateTasks,
  type GenerateTasksProcessed,
} from "./aiPostprocess.js";

export const MODEL = "claude-opus-4-8";
const MAX_INPUT_TOKENS = 180_000;
const INPUT_USD_PER_MTOK = 5;
// Adaptive thinking shares max_tokens with the output. A 40-item transcription
// plus rationales does not fit the default 16K budget, so generate-tasks runs
// with a raised cap; existing callers keep the default.
const DEFAULT_MAX_TOKENS = 16_000;
const GENERATE_TASKS_MAX_TOKENS = 32_000;

// Resolved per request (not at module load) so a key set through the
// Settings UI takes effect immediately, without a server restart.
// DB value wins; the ANTHROPIC_API_KEY env var stays as fallback.
export function resolveApiKey(): { key: string; source: "database" | "environment" } | null {
  const dbKey = getSettingString(API_KEY_SETTING);
  if (dbKey) return { key: dbKey, source: "database" };
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey) return { key: envKey, source: "environment" };
  return null;
}

export function isConfigured(): boolean {
  return resolveApiKey() !== null;
}

// Planning modes (breakdown, plan-goal) curate small, startable tasks, so
// their system prompt pushes hard toward 30-minute chunks and an easy first
// step. Transcription mode (#28) must NOT inherit those directives: a system
// prompt ordering "30 minutes or less" invites the model to shrink the
// material's own numbers at the source — corruption the deterministic
// post-processing can neither detect nor repair. It gets its own system
// prompt: same persona and title/impact rules, but the material's numbers are
// sacred and ordering follows the material, not activation energy.
export const PLANNING_SYSTEM_PROMPT = `You are the planning brain of "Draw", an anti-procrastination app. The user struggles with two things: getting started, and spending time on low-leverage work (e.g. studying the comfortable intro chapter instead of past exam questions).

Principles you always apply:
- Every task you propose must be independently completable in 30 minutes or less.
- Task titles start with a concrete physical action verb ("Open...", "Write...", "Solve...", "Sort..."), never vague ones ("Research...", "Look into...", "Prepare...").
- The FIRST task in any list must have near-zero activation energy — something the user can start within 10 seconds of reading it.
- Impact ratings (1-5) measure leverage toward the goal's measured outcome, not effort or difficulty. Practicing what is graded beats consuming what is comfortable: past papers, exercises, and producing output rate high; passively re-reading intros rates low.
- Be concrete and specific to the provided materials when they are given. Reference actual topics, chapters, or exercises from them.`;

export const TRANSCRIPTION_SYSTEM_PROMPT = `You are the transcription engine of "Draw", an anti-procrastination app. You turn the user's own study materials into a faithful, complete list of work items — you enumerate what the material contains; you do not plan, curate, or resize.

Principles you always apply:
- The material is the single source of truth. Numbers printed in it (points, stated times, item labels) are copied VERBATIM — never adjust, shrink, or round them to fit any target size.
- Enumerate every item the instruction asks for, in the material's own order. Do not skip items and do not merge several items into one.
- Task titles start with a concrete physical action verb ("Open...", "Write...", "Solve...", "Sort..."), never vague ones ("Research...", "Look into...", "Prepare...").
- Impact ratings (1-5) measure leverage toward the goal's measured outcome, not effort or difficulty. Practicing what is graded beats consuming what is comfortable: past papers, exercises, and producing output rate high; passively re-reading intros rates low.
- Be concrete and specific to the provided materials. Reference actual topics, chapters, or exercises from them.`;

// ---------------------------------------------------------------------------
// Errors

export class AiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function mapSdkError(e: unknown): AiError {
  if (e instanceof AiError) return e;
  if (e instanceof Anthropic.AuthenticationError) {
    return new AiError(502, "The Claude API key was rejected — set a valid key in Settings");
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new AiError(429, "Claude API rate limit hit — wait a moment and try again");
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return new AiError(502, "Could not reach the Claude API — check your internet connection");
  }
  if (e instanceof Anthropic.APIError) {
    return new AiError(502, `Claude API error: ${e.message}`);
  }
  return new AiError(500, e instanceof Error ? e.message : "unknown AI error");
}

// ---------------------------------------------------------------------------
// Materials → content blocks (materials first, cache breakpoint on the last one)

// Only text and document blocks carry materials/context (both support cache_control).
type ContentBlock = Anthropic.Messages.TextBlockParam | Anthropic.Messages.DocumentBlockParam;

interface MaterialRow {
  id: number;
  goal_id: number;
  kind: "file" | "note";
  filename: string | null;
  stored_name: string | null;
  mime_type: string | null;
  note_text: string | null;
}

function materialBlocks(materialIds: number[], goalId: number | null): ContentBlock[] {
  if (materialIds.length === 0) return [];
  const placeholders = materialIds.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT * FROM materials WHERE id IN (${placeholders})`)
    .all(...materialIds) as MaterialRow[];

  const blocks: ContentBlock[] = [];
  for (const m of rows) {
    if (goalId != null && m.goal_id !== goalId) continue; // only the task's own goal materials
    if (m.kind === "note" && m.note_text) {
      blocks.push({ type: "text", text: `<material name="user note">\n${m.note_text}\n</material>` });
    } else if (m.kind === "file" && m.stored_name) {
      const full = path.resolve(filesDir, m.stored_name);
      if (!full.startsWith(path.resolve(filesDir)) || !fs.existsSync(full)) continue;
      if (m.mime_type === "application/pdf") {
        blocks.push({
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: fs.readFileSync(full).toString("base64"),
          },
          title: m.filename ?? "document",
        });
      } else {
        blocks.push({
          type: "text",
          text: `<material name="${m.filename}">\n${fs.readFileSync(full, "utf-8")}\n</material>`,
        });
      }
    }
  }

  // Cache breakpoint on the last material block: repeated calls against the
  // same materials within the TTL read the prefix at ~10% cost.
  const last = blocks[blocks.length - 1];
  if (last) last.cache_control = { type: "ephemeral" };
  return blocks;
}

// ---------------------------------------------------------------------------
// Context assembly

function taskContext(taskId: number): { blocks: ContentBlock[]; goalId: number | null } {
  const task = db
    .prepare(
      `SELECT t.id, t.title, t.description, t.effort_minutes AS effort, t.due_date AS dueDate, t.goal_id AS goalId,
              c.name AS category
       FROM tasks t JOIN categories c ON c.id = t.category_id WHERE t.id = ?`,
    )
    .get(taskId) as
    | { id: number; title: string; description: string | null; effort: number | null; dueDate: string | null; goalId: number | null; category: string }
    | undefined;
  if (!task) throw new AiError(404, "task not found");

  const goal = task.goalId
    ? (db.prepare("SELECT title, outcome, target_date AS targetDate FROM goals WHERE id = ?").get(task.goalId) as
        | { title: string; outcome: string | null; targetDate: string | null }
        | undefined)
    : undefined;

  const siblings = db
    .prepare("SELECT title, status FROM tasks WHERE parent_id = ?")
    .all(taskId) as { title: string; status: string }[];

  const maxEffort = getSetting("max_draw_effort", 30);
  const lines = [
    `Break this task into 2-8 subtasks of at most ${maxEffort} minutes each.`,
    ``,
    `Task: ${task.title}`,
    task.description ? `Description: ${task.description}` : "",
    `Category: ${task.category}`,
    task.effort ? `User's total effort estimate: ${task.effort} minutes` : "",
    task.dueDate ? `Due date: ${task.dueDate} (today is ${new Date().toISOString().slice(0, 10)})` : "",
    goal ? `Linked goal: ${goal.title}` : "",
    goal?.outcome ? `Goal is measured by: ${goal.outcome}` : "",
    goal?.targetDate ? `Goal target date: ${goal.targetDate}` : "",
    siblings.length > 0
      ? `Existing subtasks (do NOT duplicate these): ${siblings.map((s) => `"${s.title}" (${s.status})`).join(", ")}`
      : "",
    ``,
    `Order subtasks by recommended execution sequence. Remember: the first one must be trivially easy to start.`,
    `Set orderMatters to true only when the steps genuinely build on each other (e.g. outline -> draft -> proofread), so doing a later step first would be wasted work; set it to false when the steps are independent.`,
  ].filter(Boolean);

  return { blocks: [{ type: "text", text: lines.join("\n") }], goalId: task.goalId };
}

function goalFacts(goalId: number) {
  const goal = db
    .prepare("SELECT title, outcome, target_date AS targetDate FROM goals WHERE id = ?")
    .get(goalId) as { title: string; outcome: string | null; targetDate: string | null } | undefined;
  if (!goal) throw new AiError(404, "goal not found");

  const existing = db
    .prepare("SELECT title, status, impact FROM tasks WHERE goal_id = ? AND status != 'archived'")
    .all(goalId) as { title: string; status: string; impact: number }[];

  return { goal, existing };
}

function goalContext(goalId: number, userNotes?: string): ContentBlock[] {
  const { goal, existing } = goalFacts(goalId);

  const today = new Date().toISOString().slice(0, 10);
  const daysLeft = goal.targetDate
    ? Math.ceil((new Date(goal.targetDate).getTime() - Date.now()) / 86_400_000)
    : null;

  const maxEffort = getSetting("max_draw_effort", 30);
  const lines = [
    `Plan backward from this goal's measured outcome.`,
    ``,
    `Goal: ${goal.title}`,
    goal.outcome ? `Measured by: ${goal.outcome}` : `The user has not specified how success is measured — infer the most likely assessment and say so in your outcomeAnalysis.`,
    goal.targetDate ? `Target date: ${goal.targetDate} (today is ${today}, ${daysLeft} days left)` : "",
    userNotes ? `User notes for this planning session: ${userNotes}` : "",
    existing.length > 0
      ? `Existing tasks for this goal (do NOT duplicate): ${existing.map((t) => `"${t.title}" (${t.status}, ${t.impact}★)`).join(", ")}`
      : "",
    ``,
    `First, in outcomeAnalysis: state concretely what gets assessed/measured (if materials include past exams or a syllabus, name the actual topics and question types).`,
    `Then propose 4-10 tasks of at most ${maxEffort} minutes each, highest leverage first, phased as now/next/later relative to the time remaining.`,
    `Bias hard toward practicing what is graded (past questions, producing output) over passive consumption.`,
  ].filter(Boolean);

  return [{ type: "text", text: lines.join("\n") }];
}

// Transcription mode (#28): enumerate what the material contains instead of
// curating a plan. The material's own numbers (points, stated minutes) are
// sacred — they are copied verbatim and audited row-by-row during review.
function generateTasksContext(goalId: number, instruction: string): ContentBlock[] {
  const { goal, existing } = goalFacts(goalId);
  const maxEffort = getSetting("max_draw_effort", 30);

  const lines = [
    `TRANSCRIPTION MODE — this is not a planning request. Enumerate EVERY exercise/item the instruction below asks for from the provided materials. Do not curate, do not skip items, do not merge several items into one.`,
    ``,
    `Goal: ${goal.title}`,
    goal.outcome ? `Measured by: ${goal.outcome}` : "",
    goal.targetDate ? `Target date: ${goal.targetDate} (today is ${new Date().toISOString().slice(0, 10)})` : "",
    existing.length > 0
      ? `Existing tasks for this goal (do NOT duplicate): ${existing.map((t) => `"${t.title}" (${t.status})`).join(", ")}`
      : "",
    ``,
    `User instruction: ${instruction}`,
    ``,
    `Rules for each item:`,
    `- sourceOverview: one short paragraph describing what the material contains, including the total item count you see.`,
    `- label: the exercise/item number exactly as printed ("7", "7b"); null when the material shows none.`,
    `- statedMinutes: a time estimate printed in the material, copied VERBATIM — never adjust it. points: as printed, null when absent.`,
    `- estimatedMinutes: your own estimate, used only when the material states no time.`,
    `- title: concrete action verb referencing the item's actual content, not just its number.`,
    `- rationale: terse, and it MUST cite the source data (e.g. "Ex. 7, 12 pts, ~20 min per the PDF") so every row can be audited against the material.`,
    `- Transcribe items at their true size — never shrink an estimate to fit. If an item exceeds ${maxEffort} minutes, split it into parts along the material's own sub-question boundaries (a/b/c), each part at most ${maxEffort} minutes. Otherwise leave parts empty.`,
    `- Hard caps: at most ${MAX_ITEMS} items, at most ${MAX_PARTS_PER_ITEM} parts per item.`,
  ].filter(Boolean);

  return [{ type: "text", text: lines.join("\n") }];
}

// ---------------------------------------------------------------------------
// API calls

function requireClient(): Anthropic {
  const resolved = resolveApiKey();
  if (!resolved) throw new AiError(503, "ai_not_configured");
  return new Anthropic({ apiKey: resolved.key });
}

async function guardTokens(blocks: ContentBlock[], system: string): Promise<number> {
  const c = requireClient();
  try {
    const count = await c.messages.countTokens({
      model: MODEL,
      system,
      messages: [{ role: "user", content: blocks }],
    });
    if (count.input_tokens > MAX_INPUT_TOKENS) {
      throw new AiError(
        400,
        `Selected materials are too large (${count.input_tokens.toLocaleString()} tokens, limit ${MAX_INPUT_TOKENS.toLocaleString()}) — deselect some materials`,
      );
    }
    return count.input_tokens;
  } catch (e) {
    throw mapSdkError(e);
  }
}

export type EstimateMode = "breakdown" | "plan-goal" | "generate-tasks";

/**
 * Which paid call an estimate must mirror. The token count is only honest when
 * it covers the same context assembly and system prompt the paid call will
 * send (PR #42 nit): a goal estimate WITH an instruction is a generate-tasks
 * estimate, so it counts `generateTasksContext` (which embeds the instruction
 * and the per-item rules) under the transcription prompt — not the plan-goal
 * shape plus a loose instruction block.
 */
export function estimateMode(input: {
  taskId?: number;
  goalId?: number;
  instruction?: string;
}): EstimateMode {
  if (input.taskId != null) return "breakdown";
  if (input.goalId == null) throw new AiError(400, "taskId or goalId required");
  // typeof guard: request bodies reach this unvalidated (the 400 sweep across
  // AI routes is a separate issue) — a non-string must not crash the estimate.
  return typeof input.instruction === "string" && input.instruction.trim()
    ? "generate-tasks"
    : "plan-goal";
}

export async function estimate(input: {
  taskId?: number;
  goalId?: number;
  materialIds?: number[];
  instruction?: string;
}): Promise<{ inputTokens: number; estimatedUsd: number }> {
  const materialIds = input.materialIds ?? [];
  const mode = estimateMode(input);
  let blocks: ContentBlock[];
  let system = PLANNING_SYSTEM_PROMPT;
  if (mode === "breakdown") {
    const ctx = taskContext(input.taskId!);
    blocks = [...materialBlocks(materialIds, ctx.goalId), ...ctx.blocks];
  } else if (mode === "plan-goal") {
    blocks = [...materialBlocks(materialIds, input.goalId!), ...goalContext(input.goalId!)];
  } else {
    blocks = [
      ...materialBlocks(materialIds, input.goalId!),
      ...generateTasksContext(input.goalId!, input.instruction!.trim()),
    ];
    system = TRANSCRIPTION_SYSTEM_PROMPT;
  }
  const inputTokens = await guardTokens(blocks, system).catch((e: AiError) => {
    // Even over-limit estimates should report the number, not fail.
    const match = /\(([\d,.]+) tokens/.exec(e.message);
    if (e.status === 400 && match) return Number(match[1].replace(/[,.]/g, ""));
    throw e;
  });
  return {
    inputTokens,
    estimatedUsd: Math.round((inputTokens * INPUT_USD_PER_MTOK) / 1_000) / 1_000,
  };
}

async function runStructured<T>(
  blocks: ContentBlock[],
  schema: ZodType<T>,
  opts: { maxTokens?: number; system?: string } = {},
): Promise<T> {
  const c = requireClient();
  const system = opts.system ?? PLANNING_SYSTEM_PROMPT;
  await guardTokens(blocks, system);
  try {
    const response = await c.messages.parse({
      model: MODEL,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      thinking: { type: "adaptive" },
      system,
      messages: [{ role: "user", content: blocks }],
      output_config: { format: zodOutputFormat(schema) },
    });
    if (!response.parsed_output) {
      throw new AiError(502, "Claude returned an unparseable response — try again");
    }
    return response.parsed_output as T;
  } catch (e) {
    throw mapSdkError(e);
  }
}

export async function breakdown(taskId: number, materialIds: number[] = []): Promise<BreakdownResult> {
  const ctx = taskContext(taskId);
  const blocks = [...materialBlocks(materialIds, ctx.goalId), ...ctx.blocks];
  const result = await runStructured(blocks, breakdownSchema);
  const maxEffort = getSetting("max_draw_effort", 30);
  // Belt and braces: clamp efforts to the drawable limit.
  result.subtasks = result.subtasks.map((s) => ({
    ...s,
    effortMinutes: Math.min(Math.max(1, Math.round(s.effortMinutes)), maxEffort),
  }));
  return result;
}

export async function planGoal(
  goalId: number,
  materialIds: number[] = [],
  userNotes?: string,
): Promise<PlanGoalResult> {
  const blocks = [...materialBlocks(materialIds, goalId), ...goalContext(goalId, userNotes)];
  const result = await runStructured(blocks, planGoalSchema);
  const maxEffort = getSetting("max_draw_effort", 30);
  result.tasks = result.tasks.map((t) => ({
    ...t,
    effortMinutes: Math.min(Math.max(1, Math.round(t.effortMinutes)), maxEffort),
  }));
  return result;
}

export async function generateTasks(
  goalId: number,
  materialIds: number[] = [],
  instruction: string,
): Promise<GenerateTasksProcessed> {
  const blocks = [...materialBlocks(materialIds, goalId), ...generateTasksContext(goalId, instruction)];
  const result = await runStructured(blocks, generateTasksSchema, {
    maxTokens: GENERATE_TASKS_MAX_TOKENS,
    system: TRANSCRIPTION_SYSTEM_PROMPT,
  });
  // Deterministic post-processing (ADR-14): points → impact quintiles, and
  // split-don't-clamp for oversized items. The Math.min clamp above would
  // corrupt the material's own time data here.
  return postprocessGenerateTasks(result, getSetting("max_draw_effort", 30));
}
