import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, getSetting } from "../db.js";
import {
  AiError,
  countingBlocks,
  MAX_INPUT_TOKENS,
  mapSdkError,
  materialBlocks,
  MODEL,
  requireClient,
  usesFileSource,
  withFileIdRetry,
  type ContentBlock,
} from "./aiService.js";
import { FILES_BETA, invalidateFileIds } from "./materialFiles.js";
import { executeTool, TOOLS, type ApiClient, type ToolDef } from "../tools/catalog.js";
import {
  applyPlanError,
  createChangeset,
  expandOversizedSubtasks,
  stageCreateTask,
  stageCreateSubtasks,
  stagedTaskInputSchema,
  DRAFT_ID_RE,
  type Changeset,
  type StagedOp,
  type StagedTaskInput,
  type StageSubtasksArgs,
  type StagingContext,
} from "./agentStaging.js";
import {
  AGENT_MAX_ITERATIONS,
  AGENT_TURN_BUDGET_USD,
  runAgentLoop,
  usageUsd,
  INPUT_USD_PER_MTOK,
  type AgentUsage,
  type LoopBlock,
  type LoopMessage,
  type LoopStopReason,
} from "./agentLoop.js";
import { createSubtasksWrite, createTaskWrite } from "./taskWrites.js";

/**
 * The conversational assistant (#31, ADR-37). The loop's WRITE tools stage a
 * draft changeset — they never touch the database mid-loop; the user reviews
 * the changeset in the chat panel and applies it atomically. Read tools
 * execute live against the app's own HTTP API (ADR-19 by construction).
 * Draw/timer/complete/update tools are deliberately absent: the draw is a
 * commitment device (ADR-13/ADR-30, #88) and v1 of the assistant is
 * create-only (the issue's scope) — an assistant that can re-draw or mutate
 * live state would undo exactly the review-before-accept contract this
 * feature exists to keep.
 */

// ---------------------------------------------------------------------------
// Session store — in-memory on purpose (single-user local app; the multi-MB
// PDF blocks in the first message must not round-trip through the browser,
// and persisting conversations would be state the product never reads back).
// Known limitation, documented in ADR-37: a server restart (tsx watch) drops
// sessions; the client surfaces the 404 as "start a new conversation".

interface AgentSession {
  id: string;
  messages: LoopMessage[];
  changeset: Changeset;
  /**
   * Identifies the PENDING changeset for apply idempotency (#143): handed to
   * the client with every turn, sent back on apply, bumped when an apply
   * consumes the changeset. Versioned instead of comparing operations —
   * apply carries the REVIEWED ops (edits, exclusions), which legitimately
   * differ from what was staged.
   */
  changesetVersion: number;
  /** The consumed changeset's outcome, kept so an honest retry reconciles (409 + original mapping). */
  lastApplied?: { version: number; created: AppliedOp[] };
  lastUsedAt: number;
}

const MAX_SESSIONS = 20;
const sessions = new Map<string, AgentSession>();

function evictOldSessions(): void {
  while (sessions.size > MAX_SESSIONS) {
    let oldest: AgentSession | undefined;
    for (const s of sessions.values()) {
      if (!oldest || s.lastUsedAt < oldest.lastUsedAt) oldest = s;
    }
    if (!oldest) return;
    sessions.delete(oldest.id);
  }
}

/** Test hook: drop all sessions (each test file has its own process anyway). */
export function resetAgentSessions(): void {
  sessions.clear();
}

// ---------------------------------------------------------------------------
// Tool surface: catalog reads bound live, catalog writes bound to staging.

// Read tools run live during the loop — reads have no review semantics and
// the model needs real ids (categories, goals, existing tasks) to stage
// correct drafts. list_materials is excluded: materials reach the assistant
// as document blocks in the first message (ADR-7/ADR-35), not as a tool.
const READ_TOOL_NAMES = ["list_tasks", "list_goals", "list_categories", "get_settings", "get_stats"];
const STAGED_TOOL_NAMES = ["create_task", "create_subtasks"] as const;

const catalogByName = new Map(TOOLS.map((t) => [t.name, t]));

function catalogTool(name: string): ToolDef {
  const def = catalogByName.get(name);
  if (!def) throw new Error(`tool ${name} missing from catalog`);
  return def;
}

const STAGED_NOTE =
  "\n\nSTAGED: in this assistant the call stages a DRAFT — nothing is written until the user " +
  "reviews and applies the changeset. The result carries a draftId; pass it as parentId in later " +
  "staged calls to build a breakdown under a draft parent.";

const draftRefSchema = z
  .union([z.number().int().positive(), z.string().regex(DRAFT_ID_RE)])
  .describe("A real task id, or the draftId of a task staged earlier in this conversation");

// The staged create_task takes the catalog's exact schema with parentId
// widened to draft references (reuse, never fork — ADR-19's catalog is the
// one vocabulary; only the binding differs).
const stagedCreateTaskShape: z.ZodRawShape = {
  ...catalogTool("create_task").inputSchema,
  parentId: draftRefSchema.optional(),
};
const stagedCreateSubtasksShape: z.ZodRawShape = {
  ...catalogTool("create_subtasks").inputSchema,
  parentId: draftRefSchema,
};

function toInputSchema(shape: z.ZodRawShape): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object(shape)) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

interface ApiToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** The tool list sent with every model request (stable → cacheable prefix). */
export function agentApiTools(): ApiToolDef[] {
  const reads = READ_TOOL_NAMES.map((name) => {
    const def = catalogTool(name);
    return { name, description: def.description, input_schema: toInputSchema(def.inputSchema) };
  });
  return [
    ...reads,
    {
      name: "create_task",
      description: catalogTool("create_task").description + STAGED_NOTE,
      input_schema: toInputSchema(stagedCreateTaskShape),
    },
    {
      name: "create_subtasks",
      description: catalogTool("create_subtasks").description + STAGED_NOTE,
      input_schema: toInputSchema(stagedCreateSubtasksShape),
    },
  ];
}

const API_TOOLS = agentApiTools();

function stagingContext(): StagingContext {
  return {
    categoryExists: (id) => Boolean(db.prepare("SELECT 1 FROM categories WHERE id = ?").get(id)),
    goalExists: (id) => Boolean(db.prepare("SELECT 1 FROM goals WHERE id = ?").get(id)),
    taskInfo: (id) => {
      const row = db.prepare("SELECT parent_id AS parentId, status FROM tasks WHERE id = ?").get(id) as
        | { parentId: number | null; status: string }
        | undefined;
      return row ? { isSubtask: row.parentId != null, archived: row.status === "archived" } : null;
    },
    maxDrawEffort: getSetting("max_draw_effort", 30),
  };
}

// The API's ApiClient for live reads. Bound by createApp() (app.ts) to an
// in-process client against the very app instance serving this request.
let toolApi: ApiClient | null = null;
export function bindAgentToolApi(api: ApiClient): void {
  toolApi = api;
}

const stagedCreateTaskArgs = z.object(stagedCreateTaskShape);
const stagedCreateSubtasksArgs = z.object(stagedCreateSubtasksShape);

async function runAgentTool(
  session: AgentSession,
  name: string,
  input: unknown,
): Promise<{ text: string; isError?: boolean }> {
  if (name === "create_task") {
    const parsed = stagedCreateTaskArgs.safeParse(input ?? {});
    if (!parsed.success) {
      return { isError: true, text: `invalid arguments for ${name}: ${z.prettifyError(parsed.error)}` };
    }
    // The spread of the catalog's generic ZodRawShape loses the static field
    // types; the runtime parse just proved the shape.
    return stageCreateTask(session.changeset, parsed.data as StagedTaskInput, stagingContext());
  }
  if (name === "create_subtasks") {
    const parsed = stagedCreateSubtasksArgs.safeParse(input ?? {});
    if (!parsed.success) {
      return { isError: true, text: `invalid arguments for ${name}: ${z.prettifyError(parsed.error)}` };
    }
    return stageCreateSubtasks(
      session.changeset,
      parsed.data as unknown as StageSubtasksArgs,
      stagingContext(),
    );
  }
  if (!READ_TOOL_NAMES.includes(name)) {
    return { isError: true, text: `unknown tool: ${name}` };
  }
  if (!toolApi) return { isError: true, text: "assistant tools are not bound to the API (server bug)" };
  return executeTool(name, toolApi, input);
}

// ---------------------------------------------------------------------------
// Prompt & model transport

// Stable on purpose (prompt caching is a prefix match): no dates, no session
// state — those travel in the first user turn.
export const AGENT_SYSTEM_PROMPT = `You are the conversational assistant of "Draw", an anti-procrastination app. The user struggles with two things: getting started, and spending time on low-leverage work. You help them turn intentions and materials into small, startable tasks.

How your tools work — this is the core contract:
- Read tools (list_tasks, list_goals, list_categories, get_settings, get_stats) return LIVE data.
- Write tools (create_task, create_subtasks) stage DRAFTS into a changeset. NOTHING is saved when you call them. The user reviews the changeset next to this conversation and applies it — only then do tasks exist. Never tell the user a task "has been created"; say it is staged or proposed. Staged drafts do NOT appear in list_tasks.
- Staged create_task returns a draftId. Use it as the parentId of create_subtasks (or of another staged create_task) to build a breakdown under a draft parent.

Principles you always apply:
- Before staging, read what exists: list_categories for the required categoryId, list_goals when the work serves a goal, list_tasks to avoid duplicates.
- Every leaf task must be independently completable within max_draw_effort minutes (get_settings). Bigger work becomes a parent task plus create_subtasks steps. NEVER shrink an effort estimate to fit the limit — split the work instead; stated estimates are the user's data.
- Task titles start with a concrete physical action verb ("Open...", "Write...", "Solve..."), never vague ones ("Research...", "Prepare...").
- The FIRST task of any breakdown must have near-zero activation energy — startable within 10 seconds of reading it.
- Impact ratings (1-5) measure leverage toward the linked goal's measured outcome, not effort. Non-neutral impact requires a goal link.
- Be concrete and specific to the user's materials when they are provided in this conversation.
- Stage each change once. If the user asks for adjustments, explain what to change — the review panel lets them edit titles and efforts directly — and stage only genuinely new items.

You cannot draw cards, start timers, or complete/edit existing tasks: drawing is the user's own commitment ritual, and this assistant only proposes new work for review.`;

export const AGENT_MAX_TOKENS = 16_000;

// The system prompt carries a cache breakpoint (render order is tools →
// system → messages, so this one breakpoint caches the tool list too):
// material-less conversations would otherwise re-send the full prefix
// uncached on each of the loop's up-to-8 iterations and every follow-up
// turn. With materials selected, materialBlocks() adds a second, later
// breakpoint on the last document block — 2 of the 4 allowed per request.
// Below the model's minimum cacheable prefix this is a silent no-op.
const AGENT_SYSTEM_BLOCKS: Anthropic.Beta.Messages.BetaTextBlockParam[] = [
  { type: "text", text: AGENT_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
];

interface SessionLike {
  messages: LoopMessage[];
}

function needsFilesBeta(session: SessionLike): boolean {
  const first = session.messages[0];
  if (!first || !Array.isArray(first.content)) return false;
  return (first.content as ContentBlock[]).some((b) => usesFileSource(b));
}

async function callModel(
  client: Anthropic,
  messages: LoopMessage[],
  filesBeta: boolean,
): Promise<{ content: LoopBlock[]; stopReason: string | null; usage: Anthropic.Beta.Messages.BetaUsage }> {
  try {
    // Streaming is required, not a preference (ADR-36): every structured AI
    // call streams so no max_tokens raise can trip the SDK's >10-minute
    // non-streaming guard live-only. Same stream()/finalMessage() seam the
    // suites mock (#133/#136).
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: AGENT_MAX_TOKENS,
      thinking: { type: "adaptive" },
      system: AGENT_SYSTEM_BLOCKS,
      messages: messages as unknown as Anthropic.Beta.Messages.BetaMessageParam[],
      tools: API_TOOLS as unknown as Anthropic.Beta.Messages.BetaToolUnion[],
      betas: filesBeta ? [FILES_BETA] : undefined,
    });
    const msg = await stream.finalMessage();
    return {
      content: msg.content as unknown as LoopBlock[],
      stopReason: msg.stop_reason,
      usage: msg.usage,
    };
  } catch (e) {
    throw mapSdkError(e);
  }
}

async function guardAgentTokens(client: Anthropic, messages: LoopMessage[]): Promise<number> {
  try {
    // count_tokens rejects file-source blocks (#138) — count the substituted
    // base64 view of the same bytes; the paid calls keep the file ids.
    const counting = messages.map((m) =>
      Array.isArray(m.content)
        ? { ...m, content: countingBlocks(m.content as ContentBlock[]) as LoopBlock[] }
        : m,
    );
    const count = await client.beta.messages.countTokens({
      model: MODEL,
      // Same block shape as the paid call so the counted prefix mirrors it.
      system: AGENT_SYSTEM_BLOCKS,
      messages: counting as unknown as Anthropic.Beta.Messages.BetaMessageParam[],
      tools: API_TOOLS as unknown as Anthropic.Beta.Messages.BetaToolUnion[],
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

function firstTurnText(input: { goalId?: number; materialIds?: number[]; message: string }): string {
  const lines = [`Today is ${new Date().toISOString().slice(0, 10)}.`];
  if (input.goalId != null) {
    const goal = db
      .prepare("SELECT title, outcome, target_date AS targetDate FROM goals WHERE id = ?")
      .get(input.goalId) as { title: string; outcome: string | null; targetDate: string | null } | undefined;
    if (!goal) throw new AiError(404, "goal not found");
    lines.push(
      `This conversation is about goal #${input.goalId}: "${goal.title}"` +
        (goal.outcome ? ` — measured by: ${goal.outcome}` : "") +
        (goal.targetDate ? ` — target date ${goal.targetDate}` : "") +
        ".",
    );
  }
  if ((input.materialIds?.length ?? 0) > 0) {
    lines.push("The documents above are the materials the user selected for this conversation.");
  }
  return [...lines, "", input.message].join("\n");
}

// ---------------------------------------------------------------------------
// The message turn

export interface AgentTurnUsage extends AgentUsage {
  /** ACTUAL cost of the turn from per-iteration usage — unlike the estimate endpoint's input-only estimatedUsd. */
  costUsd: number;
}

export interface AgentTurnResult {
  sessionId: string;
  reply: string;
  changeset: { version: number; ops: StagedOp[] };
  usage: AgentTurnUsage;
  stopped?: LoopStopReason;
}

const STOP_EXPLANATIONS: Record<LoopStopReason, string> = {
  max_iterations:
    "Stopped: the assistant hit its per-message iteration cap. The changes staged so far are shown for review — send another message to continue.",
  token_budget:
    "Stopped: this message hit its token budget. The changes staged so far are shown for review — send another message to continue.",
  truncated:
    "Stopped: the reply was cut off mid-tool-call by the output limit; the cut-off calls were not executed. The changes staged so far are shown for review — send another message to continue.",
};

export async function runAgentTurn(input: {
  sessionId?: string;
  goalId?: number;
  materialIds?: number[];
  message: string;
}): Promise<AgentTurnResult> {
  const client = requireClient();

  let session = input.sessionId ? sessions.get(input.sessionId) : undefined;
  if (input.sessionId && !session) {
    throw new AiError(
      404,
      "session not found — it was lost (conversations are in-memory and do not survive a server restart); start a new conversation",
    );
  }
  const isNew = !session;
  if (!session) {
    session = {
      id: randomUUID(),
      messages: [],
      changeset: createChangeset(),
      changesetVersion: 1,
      lastUsedAt: Date.now(),
    };
    sessions.set(session.id, session);
    evictOldSessions();
  }
  session.lastUsedAt = Date.now();
  const s = session;

  const finish = async (): Promise<AgentTurnResult> => {
    const result = await runAgentLoop(s.messages, {
      callModel: (messages) => callModel(client, messages, needsFilesBeta(s)),
      runTool: (name, toolInput) => runAgentTool(s, name, toolInput),
      maxIterations: AGENT_MAX_ITERATIONS,
      budgetUsd: AGENT_TURN_BUDGET_USD,
    });
    const reply =
      result.stopped != null
        ? [result.reply, STOP_EXPLANATIONS[result.stopped]].filter(Boolean).join("\n\n")
        : result.reply;
    return {
      sessionId: s.id,
      reply,
      changeset: { version: s.changesetVersion, ops: s.changeset.ops },
      usage: {
        ...result.usage,
        costUsd: Math.round(usageUsd(result.usage) * 1000) / 1000,
      },
      ...(result.stopped ? { stopped: result.stopped } : {}),
    };
  };

  if (!isNew) {
    // Follow-up turns carry only the message: materials and goal context
    // entered with the first turn, and re-sending them would duplicate
    // multi-MB blocks in the same conversation.
    s.messages.push({ role: "user", content: [{ type: "text", text: input.message }] });
    return finish();
  }

  const materialIds = input.materialIds ?? [];
  // First turn: materials + context, under the token guard, self-healing a
  // stale cached file id exactly like every other AI call (#92, ADR-35). A
  // retried build resets the conversation — only reads and session-local
  // staging can have happened, so the rerun is side-effect-free.
  return withFileIdRetry(
    () => materialBlocks(materialIds, input.goalId ?? null),
    async (blocks) => {
      s.messages = [];
      s.changeset = createChangeset();
      const content: LoopBlock[] = [
        ...(blocks as unknown as LoopBlock[]),
        { type: "text", text: firstTurnText(input) },
      ];
      const probe: LoopMessage[] = [{ role: "user", content }];
      await guardAgentTokens(client, probe);
      s.messages.push({ role: "user", content });
      return finish();
    },
    () => invalidateFileIds(materialIds),
  );
}

// ---------------------------------------------------------------------------
// Estimate gate (#31): the first send is priced before it runs, like every
// other AI surface. Input-only by nature — output cannot be known up front;
// the per-turn usage line reports the actual cost including output.

export async function agentEstimate(input: {
  goalId?: number;
  materialIds?: number[];
  message: string;
}): Promise<{ inputTokens: number; estimatedUsd: number }> {
  const client = requireClient();
  const materialIds = input.materialIds ?? [];
  const inputTokens = await withFileIdRetry(
    () => materialBlocks(materialIds, input.goalId ?? null),
    (blocks) =>
      guardAgentTokens(client, [
        {
          role: "user",
          content: [...(blocks as unknown as LoopBlock[]), { type: "text", text: firstTurnText(input) }],
        },
      ]),
    () => invalidateFileIds(materialIds),
  ).catch((e: AiError) => {
    // Over-limit estimates report the number instead of failing (the
    // estimate() precedent): the gate exists to inform, not to block twice.
    const match = /\(([\d,.]+) tokens/.exec(e.message);
    if (e.status === 400 && match) return Number(match[1].replace(/[,.]/g, ""));
    throw e;
  });
  return {
    inputTokens,
    estimatedUsd: Math.round((inputTokens * INPUT_USD_PER_MTOK) / 1_000) / 1_000,
  };
}

// ---------------------------------------------------------------------------
// Apply: ONE transaction through the same cores the task routes run.

export interface AppliedOp {
  draftId: string;
  taskIds: number[];
}

export interface ApplyOutcome {
  created: AppliedOp[];
  /**
   * True when this apply targeted an ALREADY CONSUMED changeset (#143):
   * nothing was written and `created` is the original apply's mapping, so an
   * honest retry (timeout after commit, HTTP-level replay) reconciles instead
   * of duplicating. The route answers it as 409 + mapping.
   */
  alreadyApplied?: boolean;
}

/**
 * Apply the reviewed operations atomically. Draft parents resolve to real
 * ids in list order; any rejection (the route cores' own 400s — ADR-4 impact
 * gate, ADR-16 one-level, missing category/goal, archived parents) throws
 * and rolls back the WHOLE changeset (better-sqlite3 nests the cores' inner
 * transactions as savepoints under this one). Oversized subtask efforts are
 * split, never clamped (#28's policy) — re-run here because the reviewer can
 * edit efforts after staging.
 *
 * A successful apply CONSUMES the session's changeset (#143): the ops clear,
 * the version bumps, and the created mapping is kept so a re-apply of the
 * consumed version reconciles (alreadyApplied above) instead of creating
 * every task again. Sessions may legitimately be gone (restart) — then apply
 * proceeds stateless, the pre-existing accepted limitation (ADR-37).
 */
export function applyOperations(
  operations: StagedOp[],
  sessionId?: string,
  changesetVersion?: number,
): ApplyOutcome {
  const planError = applyPlanError(operations);
  if (planError) throw new AiError(400, planError);

  // The idempotency gate runs BEFORE any write. Keyed per-changeset by
  // version, never by comparing operations — the body carries the REVIEWED
  // ops (title/effort edits, exclusions), which may differ from the staged
  // ops of the very changeset they came from.
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (session) {
    if (changesetVersion != null) {
      if (changesetVersion > session.changesetVersion) {
        throw new AiError(
          400,
          `unknown changeset version ${changesetVersion} — this session's pending changeset is version ${session.changesetVersion}`,
        );
      }
      if (changesetVersion < session.changesetVersion) {
        if (session.lastApplied?.version === changesetVersion) {
          return { created: session.lastApplied.created, alreadyApplied: true };
        }
        // Only the LAST consumed changeset's mapping is kept; an older
        // version cannot reconcile, but it must never re-create tasks.
        throw new AiError(
          409,
          "this changeset was already applied and its result is no longer available — check the Tasks page",
        );
      }
      // changesetVersion === current: a fresh apply of the pending changeset.
    } else if (session.changeset.ops.length === 0 && session.lastApplied) {
      // Version-less caller (the #143 live repro: the same {sessionId,
      // operations} POSTed twice): nothing is pending and something was
      // applied — best-effort reconciliation with the last mapping.
      return { created: session.lastApplied.created, alreadyApplied: true };
    }
  }

  const maxEffort = getSetting("max_draw_effort", 30);

  const created = db.transaction((): AppliedOp[] => {
    const draftToId = new Map<string, number>();
    const resolveParent = (ref: number | string | undefined): number | undefined => {
      if (ref == null || typeof ref === "number") return ref ?? undefined;
      const id = draftToId.get(ref);
      // applyPlanError already validated the reference exists earlier in the
      // list; a miss here means the referenced create_task itself failed —
      // unreachable because its failure already threw.
      if (id == null) throw new AiError(400, `unresolved draft parent ${ref}`);
      return id;
    };

    const results: AppliedOp[] = [];
    for (const op of operations) {
      if (op.kind === "create_task") {
        const body: Record<string, unknown> = { ...op.task, parentId: resolveParent(op.task.parentId) };
        const r = createTaskWrite(body);
        if ("error" in r) throw new AiError(400, `${op.draftId} ("${op.task.title}"): ${r.error}`);
        draftToId.set(op.draftId, r.id);
        results.push({ draftId: op.draftId, taskIds: [r.id] });
      } else {
        const parentId = resolveParent(op.parentId)!;
        const { rows } = expandOversizedSubtasks(op.subtasks, maxEffort);
        const r = createSubtasksWrite(
          parentId,
          rows.map(({ draftId: _d, splitFrom: _s, ...rest }) => rest),
          undefined,
        );
        if ("error" in r) throw new AiError(400, `${op.draftId}: ${r.error}`);
        const byDraft = new Map<string, number[]>();
        rows.forEach((row, i) => {
          const list = byDraft.get(row.draftId) ?? [];
          list.push(r.ids[i]);
          byDraft.set(row.draftId, list);
        });
        for (const [draftId, taskIds] of byDraft) results.push({ draftId, taskIds });
      }
    }
    return results;
  })();

  // Consume the changeset (#143): a continued conversation must not
  // re-propose applied ops (the draft counter keeps running so ids never
  // collide), and a retry of THIS apply must reconcile, not duplicate — the
  // version bump plus the kept mapping is what the gate above checks.
  if (session) {
    session.lastApplied = { version: session.changesetVersion, created };
    session.changeset.ops = [];
    session.changesetVersion += 1;
  }
  return { created };
}
