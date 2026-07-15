import { z } from "zod";

// Structured outputs don't support numeric min/max — use a literal union.
const impactSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

export const breakdownSchema = z.object({
  subtasks: z.array(
    z.object({
      title: z.string(),
      effortMinutes: z.number(),
      impact: impactSchema,
      rationale: z.string(),
    }),
  ),
  approachNote: z.string(),
  // #23: the model already orders subtasks by execution sequence — this one
  // boolean says whether that sequence is binding. It only pre-sets the
  // "Do in order" toggle in the review panel; the user has the last word.
  orderMatters: z.boolean(),
});

export type BreakdownResult = z.infer<typeof breakdownSchema>;

export const planGoalSchema = z.object({
  outcomeAnalysis: z.string(),
  tasks: z.array(
    z.object({
      title: z.string(),
      effortMinutes: z.number(),
      impact: impactSchema,
      rationale: z.string(),
      phase: z.union([z.literal("now"), z.literal("next"), z.literal("later")]),
    }),
  ),
});

export type PlanGoalResult = z.infer<typeof planGoalSchema>;

// Transcription-style generation (#28): unlike plan-goal's curated 4-10 tasks,
// this enumerates every item the instruction asks for. statedMinutes/points are
// the material's own data (kept verbatim); estimatedMinutes is the model's
// estimate for items the material doesn't size. Exactly one nesting level
// (parts) — task lists render only roots plus one child level.
export const generateTasksSchema = z.object({
  sourceOverview: z.string(),
  tasks: z.array(
    z.object({
      label: z.union([z.string(), z.null()]),
      title: z.string(),
      points: z.union([z.number(), z.null()]),
      statedMinutes: z.union([z.number(), z.null()]),
      estimatedMinutes: z.number(),
      suggestedImpact: impactSchema,
      rationale: z.string(),
      parts: z.array(z.object({ title: z.string(), minutes: z.number() })),
    }),
  ),
});

export type GenerateTasksResult = z.infer<typeof generateTasksSchema>;

// Card art (#27): the Claude API generates text, so the artwork is SVG markup
// written by the model through the same structured-output pipeline. The raw
// string is UNTRUSTED — svgSanitizer.ts allowlist-filters it before storage.
export const cardArtSchema = z.object({
  svg: z.string(),
});

export type CardArtResult = z.infer<typeof cardArtSchema>;
