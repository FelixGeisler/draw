import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { ZodType } from "zod";
import fs from "node:fs";
import path from "node:path";
import { API_KEY_SETTING, db, filesDir, getSetting, getSettingString } from "../db.js";
import {
  ensureFileId,
  FILES_BETA,
  invalidateFileIds,
  sdkUploader,
  type PdfUploader,
} from "./materialFiles.js";
import {
  breakdownSchema,
  cardArtSchema,
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
import { buildCardArtPrompt } from "./cardArtStyle.js";

export const MODEL = "claude-opus-4-8";
// Exported for the assistant's token guard (#31): one input ceiling for
// every AI surface.
export const MAX_INPUT_TOKENS = 180_000;
const INPUT_USD_PER_MTOK = 5;
// Adaptive thinking shares max_tokens with the output. A 40-item transcription
// plus rationales does not fit the default 16K budget, so generate-tasks runs
// with a raised cap; existing callers keep the default.
const DEFAULT_MAX_TOKENS = 16_000;
const GENERATE_TASKS_MAX_TOKENS = 32_000;
// Card art (#27): an SVG background is ~2-4K output tokens, but adaptive
// thinking shares this cap. Raised 6K -> 8K for #113: the dense archetypes
// (constellation fields, shard mosaics) legitimately emit more markup, and
// the headroom keeps light thinking from truncating it mid-tag. Reviewed
// together with the sanitizer's MAX_INPUT_LENGTH guard (svgSanitizer.ts),
// which must stay the same order of magnitude as a real generation.
const CARD_ART_MAX_TOKENS = 8_000;

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

// Card art (#27) is neither planning nor transcription — its own prompt keeps
// the task directives out and pins the constraints the sanitizer and the deck
// aesthetic rely on. #113 moved the LOOK out of this prompt: one fixed recipe
// here ("the single accent", one abstract-themes list) made every card
// converge on the same image, so the per-request style — archetype, palette
// harmony, density, focal placement — now arrives with the user prompt
// (cardArtStyle.ts, deterministic per task). What stays here are the hard
// rules no style may trade away.
export const CARD_ART_SYSTEM_PROMPT = `You are the card artist of "Draw", an anti-procrastination app that presents tasks as playing cards. You create ABSTRACT, decorative SVG artwork for the back of a drawn card. Each request names a style archetype, a palette harmony and a composition — follow them precisely: they are what keeps every card in the deck visually distinct.

Hard rules for every artwork:
- Output one single self-contained <svg> element with viewBox="0 0 300 420" (the card's 5:7 ratio), filling the whole area.
- Strictly NO text of any kind: no <text> or <tspan> elements, and no letters, digits or words drawn as paths.
- No <script>, no <foreignObject>, no <image>, no <style>, no event-handler attributes, and no external references of any kind (no http(s):, data: or file URLs) — reference only your own <defs> via url(#id) or href="#id". A server-side sanitizer strips everything else.
- Dark, calm base anchored on the card face it covers: base tones between #171d24 and #232a33 (the app's slate card stock, #255), with the requested palette harmony built around the task's category color so every card still reads as part of one deck. Keep contrast subtle — the artwork sits BEHIND light card text that must stay legible.
- Compose for a portrait art window: the focal interest lives in the upper-center region of the canvas (a card frame may crop the lower part), while the full area stays covered.
- Make it abstract and quietly evocative of the task's theme within the requested archetype. Never literal illustrations, icons, mascots or clip-art.
- Keep it compact: at most ~80 elements — express repetition through <defs> with <use> or <pattern> instead of duplicated markup. Filters are welcome (turbulence, blur, displacement, soft light) but no heavier than the archetype needs.`;

// ---------------------------------------------------------------------------
// Errors

export class AiError extends Error {
  constructor(
    public status: number,
    message: string,
    /**
     * The status the Claude API itself returned, when this wraps an SDK
     * error. Distinct from `status`, which is what WE answer our client with
     * — an Anthropic 404 is a 502 to the browser. Kept because the file-id
     * cache (#92) has to tell "that file_id is gone" apart from every other
     * upstream failure, and doing that by string-matching the message would
     * be a guess dressed up as a check.
     */
    public sdkStatus?: number,
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
    return new AiError(502, `Claude API error: ${e.message}`, e.status);
  }
  return new AiError(500, e instanceof Error ? e.message : "unknown AI error");
}

// ---------------------------------------------------------------------------
// Materials → content blocks (materials first, cache breakpoint on the last one)

// Only text and document blocks carry materials/context (both support
// cache_control). These are the BETA variants, and not by preference: the
// `{type: "file", file_id}` document source #92 needs exists only there (the
// GA DocumentBlockParam takes base64/text/content/url — checked against the
// installed SDK, see materialFiles.FILES_BETA). Hence beta blocks, and hence
// `client.beta.messages.*` below.
export type ContentBlock =
  | Anthropic.Beta.Messages.BetaTextBlockParam
  | Anthropic.Beta.Messages.BetaRequestDocumentBlock;

interface MaterialRow {
  id: number;
  goal_id: number;
  kind: "file" | "note";
  filename: string | null;
  stored_name: string | null;
  mime_type: string | null;
  note_text: string | null;
  anthropic_file_id: string | null;
}

// Windows-1252 differs from Latin-1 only in 0x80–0x9F, where it puts
// printable punctuation (€ „ “ ” – — …) instead of C1 control codes — and
// those are exactly the bytes legacy-encoded German text uses. Node's
// TextDecoder cannot do this mapping: it fast-paths every latin1-family
// label, "windows-1252" included, through a raw byte→codepoint latin1 decode
// (verified on the installed runtime: 0x97 comes back as U+0097, not the
// em-dash U+2014), so the table is hand-owned. Bytes cp1252 leaves undefined
// (0x81, 0x8D, 0x8F, 0x90, 0x9D) fall through as-is — the same passthrough
// the WHATWG encoding spec prescribes.
const CP1252_C1 = new Map<number, string>([
  [0x80, "€"], [0x82, "‚"], [0x83, "ƒ"], [0x84, "„"], [0x85, "…"], [0x86, "†"],
  [0x87, "‡"], [0x88, "ˆ"], [0x89, "‰"], [0x8a, "Š"], [0x8b, "‹"], [0x8c, "Œ"],
  [0x8e, "Ž"], [0x91, "‘"], [0x92, "’"], [0x93, "“"], [0x94, "”"],
  [0x95, "•"], [0x96, "–"], [0x97, "—"], [0x98, "˜"], [0x99, "™"], [0x9a, "š"],
  [0x9b, "›"], [0x9c, "œ"], [0x9e, "ž"], [0x9f, "Ÿ"],
]);

/**
 * Decode a text material's bytes for prompt assembly (#134). Uploads are
 * usually UTF-8, but Windows editors still save Latin-1/Windows-1252 — and a
 * lenient utf-8 read replaces every invalid byte with U+FFFD, silently
 * injecting `�` into the prompt for the model to echo back into its answers
 * (the em-dash sighting in #91's plan-goal analysis). Strict-decode UTF-8
 * first; only when the bytes are NOT valid UTF-8, decode as Windows-1252 (the
 * superset of Latin-1 that browsers assume), which maps every byte — so a
 * valid UTF-8 file round-trips byte-identically and a legacy-encoded one is
 * transcoded instead of corrupted.
 */
export function decodeTextMaterial(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return bytes
      .toString("latin1")
      .replace(/[\x80-\x9f]/g, (ch) => CP1252_C1.get(ch.charCodeAt(0)) ?? ch);
  }
}

// Exported for the assistant (#31): materials enter its FIRST user message
// through exactly this assembly (ADR-7 — whole documents, explicit selection,
// cache breakpoint on the last block), never through a tool.
export async function materialBlocks(materialIds: number[], goalId: number | null): Promise<ContentBlock[]> {
  if (materialIds.length === 0) return [];
  const placeholders = materialIds.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT * FROM materials WHERE id IN (${placeholders})`)
    .all(...materialIds) as MaterialRow[];

  // One uploader for the whole assembly; null without a key. Degraded mode
  // therefore assembles exactly the blocks it did before #92 (base64), and
  // the 503 still comes from guardTokens further down — never from here.
  const resolved = resolveApiKey();
  const upload: PdfUploader | null = resolved
    ? sdkUploader(new Anthropic({ apiKey: resolved.key }))
    : null;

  const blocks: ContentBlock[] = [];
  for (const m of rows) {
    if (goalId != null && m.goal_id !== goalId) continue; // only the task's own goal materials
    if (m.kind === "note" && m.note_text) {
      blocks.push({ type: "text", text: `<material name="user note">\n${m.note_text}\n</material>` });
    } else if (m.kind === "file" && m.stored_name) {
      const full = path.resolve(filesDir, m.stored_name);
      if (!full.startsWith(path.resolve(filesDir)) || !fs.existsSync(full)) continue;
      if (m.mime_type === "application/pdf") {
        blocks.push(await pdfBlock(m, full, upload));
      } else {
        // .txt/.md stay inline (#92 scope): they are cheap, and an inline
        // block keeps the assembled prompt readable. The win is PDFs.
        blocks.push({
          type: "text",
          text: `<material name="${m.filename}">\n${decodeTextMaterial(fs.readFileSync(full))}\n</material>`,
        });
      }
    }
  }

  // Cache breakpoint on the last material block: repeated calls against the
  // same materials within the TTL read the prefix at ~10% cost. A file-source
  // document block carries cache_control exactly like a base64 one — and its
  // bytes are now tiny AND stable across calls, so the prefix stays identical
  // where a re-read base64 payload only happened to.
  const last = blocks[blocks.length - 1];
  if (last) last.cache_control = { type: "ephemeral" };
  return blocks;
}

/**
 * A PDF material as a document block: by file id once uploaded (#92), else
 * the pre-#92 base64 payload. The fallback is load-bearing, not tidiness —
 * `ensureFileId` returns null whenever an id cannot be had (no key, upload
 * failed), and an AI feature must not break because an upload path is
 * unavailable.
 */
async function pdfBlock(
  m: MaterialRow,
  full: string,
  upload: PdfUploader | null,
): Promise<Anthropic.Beta.Messages.BetaRequestDocumentBlock> {
  const title = m.filename ?? "document";
  const fileId = await ensureFileId(m, full, upload);
  if (fileId) {
    const block: Anthropic.Beta.Messages.BetaRequestDocumentBlock = {
      type: "document",
      source: { type: "file", file_id: fileId },
      title,
    };
    // Token counting cannot use the id (#138) — remember where the bytes live.
    fileSourceLocalPath.set(block, full);
    return block;
  }
  return {
    type: "document",
    source: {
      type: "base64",
      media_type: "application/pdf",
      data: fs.readFileSync(full).toString("base64"),
    },
    title,
  };
}

/**
 * The on-disk PDF behind each file-source block of the CURRENT assembly.
 * A WeakMap keyed on the block object itself (not the file id) so the mapping
 * dies with the request that built it — it can never leak across requests or
 * outlive an invalidated id. Only `pdfBlock` writes it; only `countingBlocks`
 * reads it.
 */
const fileSourceLocalPath = new WeakMap<ContentBlock, string>();

/**
 * The blocks to COUNT, as opposed to the blocks to SEND (#138).
 *
 * The real `count_tokens` endpoint rejects `{type: "file"}` document sources
 * outright ("File sources are not supported in the token counting endpoint"),
 * so the token guard substitutes the locally-read base64 bytes for each
 * file-source block — the exact content the id references, so the count stays
 * exact — while the paid call keeps the small file_id reference. Counting
 * therefore still pays the base64 bandwidth; only the paid call sheds it.
 * `cache_control` is carried over so the counted shape mirrors the sent one.
 */
export function countingBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.map((block) => {
    if (!usesFileSource(block)) return block;
    const full = fileSourceLocalPath.get(block);
    if (!full) {
      // Only pdfBlock creates file sources and it always registers the path —
      // reaching this is a bug here, not a bad request. Fail loudly instead of
      // letting the live endpoint 400.
      throw new AiError(500, "internal: file-source document has no local path for token counting");
    }
    const doc = block as Anthropic.Beta.Messages.BetaRequestDocumentBlock;
    const substitute: Anthropic.Beta.Messages.BetaRequestDocumentBlock = {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: fs.readFileSync(full).toString("base64"),
      },
      title: doc.title,
    };
    if (block.cache_control) substitute.cache_control = block.cache_control;
    return substitute;
  });
}

/** Does this block reference a Files-API id rather than carrying its bytes? */
export function usesFileSource(block: ContentBlock): boolean {
  return block.type === "document" && block.source.type === "file";
}

/**
 * The beta header a request carrying these blocks needs — sent only when a
 * file id is actually referenced, so calls without materials (card art, a
 * task with none) keep exactly the request shape they had before #92.
 */
function betasFor(blocks: ContentBlock[]): Anthropic.AnthropicBeta[] | undefined {
  return blocks.some(usesFileSource) ? [FILES_BETA] : undefined;
}

/**
 * Did Anthropic reject the request because a file id we cached is gone —
 * expired, uploaded by a different account, or restored from a backup made on
 * another machine (#61)?
 *
 * Scoped to requests that actually reference a file id, so an unrelated 404
 * (a bad model id is one) can never trigger a pointless re-upload. The 400 arm
 * is deliberate slack: this repo has no key, so the exact rejection shape for
 * a dead id cannot be observed here (#91 verifies it live). Guessing wrong
 * costs one wasted re-upload; guessing too narrow costs a broken feature.
 *
 * One class of 400 is excluded from that slack (#138): a capability rejection
 * — the API refusing the REQUEST SHAPE, phrased "... not supported ..." — says
 * nothing about the id's liveness, and re-uploading can never fix it. Before
 * the exclusion, count_tokens' "File sources are not supported in the token
 * counting endpoint" matched the /file/i slack and every material-backed call
 * invalidated a perfectly good id and burned a re-upload before failing again.
 */
export function isStaleFileIdError(e: unknown, blocks: ContentBlock[]): boolean {
  if (!(e instanceof AiError) || !blocks.some(usesFileSource)) return false;
  if (e.sdkStatus === 404) return true;
  if (/not supported/i.test(e.message)) return false;
  return e.sdkStatus === 400 && /file/i.test(e.message);
}

/**
 * Run an AI call against freshly assembled blocks; if Anthropic rejects a
 * cached file id, drop the ids and rebuild ONCE from disk (#92, ADR-35).
 *
 * Exactly one retry: the rebuild re-uploads, so a second rejection is a real
 * failure and must surface rather than loop. This is the whole cache-coherence
 * policy in one place — and, being free of the DB and the SDK, the one part of
 * it that can be pinned by a test without a key.
 */
export async function withFileIdRetry<T>(
  build: () => Promise<ContentBlock[]>,
  run: (blocks: ContentBlock[]) => Promise<T>,
  invalidate: () => void,
): Promise<T> {
  const blocks = await build();
  try {
    return await run(blocks);
  } catch (e) {
    if (!isStaleFileIdError(e, blocks)) throw e;
    invalidate();
    return await run(await build());
  }
}

/** Assemble `materials ++ rest` and run `run` under the file-id retry policy. */
function withMaterials<T>(
  materialIds: number[],
  goalId: number | null,
  rest: ContentBlock[],
  run: (blocks: ContentBlock[]) => Promise<T>,
): Promise<T> {
  return withFileIdRetry(
    async () => [...(await materialBlocks(materialIds, goalId)), ...rest],
    run,
    () => invalidateFileIds(materialIds),
  );
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

// Theming inputs for the card art (#27): task title, category name + color,
// and the goal title when the task is linked to one. Deliberately no
// materials — the artwork keys off what the card says, not what it cites.
// The prompt text itself — including the deterministic per-task style
// directives (#113) — is built by the pure buildCardArtPrompt, so tests can
// verify it without a DB or an API call; this wrapper only adds the lookup.
function cardArtContext(taskId: number): ContentBlock[] {
  const task = db
    .prepare(
      `SELECT t.title, t.goal_id AS goalId, c.name AS category, c.color
       FROM tasks t JOIN categories c ON c.id = t.category_id WHERE t.id = ?`,
    )
    .get(taskId) as
    | { title: string; goalId: number | null; category: string; color: string }
    | undefined;
  if (!task) throw new AiError(404, "task not found");

  const goal = task.goalId
    ? (db.prepare("SELECT title FROM goals WHERE id = ?").get(task.goalId) as
        | { title: string }
        | undefined)
    : undefined;

  const text = buildCardArtPrompt({
    taskId,
    title: task.title,
    category: task.category,
    color: task.color,
    goalTitle: goal?.title ?? null,
  });
  return [{ type: "text", text }];
}

// ---------------------------------------------------------------------------
// API calls

// Exported for the assistant (#31) — same 503 degraded contract everywhere.
export function requireClient(): Anthropic {
  const resolved = resolveApiKey();
  if (!resolved) throw new AiError(503, "ai_not_configured");
  return new Anthropic({ apiKey: resolved.key });
}

// mapSdkError is exported for the assistant's loop (#31): its streamed calls
// hit the same SDK error classes runStructured's do, and the mapping to
// client-facing statuses must not fork.
export { mapSdkError };

async function guardTokens(blocks: ContentBlock[], system: string): Promise<number> {
  const c = requireClient();
  try {
    // count_tokens REJECTS file-source blocks (#138), so the guard counts the
    // substituted base64 view of the same content — exact count, no upload —
    // while the paid call keeps the file_id. The counted request carries no
    // file source, hence no files beta: it has exactly the pre-#92 shape.
    const counted = countingBlocks(blocks);
    const count = await c.beta.messages.countTokens({
      model: MODEL,
      system,
      messages: [{ role: "user", content: counted }],
      betas: betasFor(counted),
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
  // typeof guard kept as defense in depth: routes/ai.ts rejects non-string
  // instructions with a 400 up front (#84), but a direct caller of estimate()
  // must not crash on one either.
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
  let rest: ContentBlock[];
  let system = PLANNING_SYSTEM_PROMPT;
  let goalId: number | null;
  if (mode === "breakdown") {
    const ctx = taskContext(input.taskId!);
    rest = ctx.blocks;
    goalId = ctx.goalId;
  } else if (mode === "plan-goal") {
    rest = goalContext(input.goalId!);
    goalId = input.goalId!;
  } else {
    rest = generateTasksContext(input.goalId!, input.instruction!.trim());
    goalId = input.goalId!;
    system = TRANSCRIPTION_SYSTEM_PROMPT;
  }
  // The estimate self-heals a stale file id exactly like the paid call it
  // gates — a count_tokens 404 would otherwise surface as a raw 502.
  const inputTokens = await withMaterials(materialIds, goalId, rest, (blocks) =>
    guardTokens(blocks, system),
  ).catch((e: AiError) => {
    // Even over-limit estimates should report the number, not fail. (This is
    // an AiError(400) thrown by guardTokens itself, not a stale-file error —
    // it carries no sdkStatus, so the retry wrapper let it through.)
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
    // Streaming is required, not a preference (#133, ADR-36): the SDK refuses
    // any NON-streaming request whose max_tokens implies a possible
    // >10-minute run ("Streaming is required for operations that may take
    // longer than 10 minutes"), and generate-tasks' 32K cap trips that guard
    // on real calls — the flagship exam import 500'd live (#91) while every
    // mocked test stayed green. ALL structured calls stream, not just the 32K
    // one, so no future cap raise can silently reintroduce the failure class.
    // Semantics are unchanged: the stream helper accumulates the SSE deltas
    // and applies the same beta parser (zod validation via
    // output_config.format) to the final message, so parsed_output behaves
    // exactly as messages.parse() did; request-level API errors reject
    // finalMessage() with the same typed SDK errors mapSdkError already
    // handles; and the request shape (cache_control breakpoints, betas,
    // count_tokens preflight) is byte-identical apart from stream mode, so
    // prompt caching and the token guard are unaffected.
    const stream = c.beta.messages.stream({
      model: MODEL,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      thinking: { type: "adaptive" },
      system,
      messages: [{ role: "user", content: blocks }],
      output_config: { format: betaZodOutputFormat(schema) },
      betas: betasFor(blocks),
    });
    const response = await stream.finalMessage();
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
  const result = await withMaterials(materialIds, ctx.goalId, ctx.blocks, (blocks) =>
    runStructured(blocks, breakdownSchema),
  );
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
  const result = await withMaterials(materialIds, goalId, goalContext(goalId, userNotes), (blocks) =>
    runStructured(blocks, planGoalSchema),
  );
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
  const result = await withMaterials(
    materialIds,
    goalId,
    generateTasksContext(goalId, instruction),
    (blocks) =>
      runStructured(blocks, generateTasksSchema, {
        maxTokens: GENERATE_TASKS_MAX_TOKENS,
        system: TRANSCRIPTION_SYSTEM_PROMPT,
      }),
  );
  // Deterministic post-processing (ADR-14): points → impact quintiles, and
  // split-don't-clamp for oversized items. The Math.min clamp above would
  // corrupt the material's own time data here.
  return postprocessGenerateTasks(result, getSetting("max_draw_effort", 30));
}

/**
 * Card art (#27): returns the RAW model SVG. Callers must run it through
 * svgSanitizer before storing or serving it — cardArtService owns that step
 * (plus the once-per-task cache); nothing else should call this directly.
 */
export async function generateCardArt(taskId: number): Promise<string> {
  const result = await runStructured(cardArtContext(taskId), cardArtSchema, {
    maxTokens: CARD_ART_MAX_TOKENS,
    system: CARD_ART_SYSTEM_PROMPT,
  });
  return result.svg;
}
