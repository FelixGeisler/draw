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
