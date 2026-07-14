import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

export interface AiStatus {
  configured: boolean;
  model: string;
}

export interface AiEstimate {
  inputTokens: number;
  estimatedUsd: number;
}

export interface AiSubtask {
  title: string;
  effortMinutes: number;
  impact: 1 | 2 | 3 | 4 | 5;
  rationale: string;
}

export interface BreakdownResult {
  subtasks: AiSubtask[];
  approachNote: string;
}

export interface PlanTask extends AiSubtask {
  phase: "now" | "next" | "later";
}

export interface PlanGoalResult {
  outcomeAnalysis: string;
  tasks: PlanTask[];
}

export function useAiStatus() {
  return useQuery({
    queryKey: ["ai-status"],
    queryFn: () => api.get<AiStatus>("/api/ai/status"),
    staleTime: 60_000,
  });
}

export function useAiEstimate() {
  return useMutation({
    mutationFn: (input: { taskId?: number; goalId?: number; materialIds: number[] }) =>
      api.post<AiEstimate>("/api/ai/estimate", input),
  });
}

export function useAiBreakdown() {
  return useMutation({
    mutationFn: (input: { taskId: number; materialIds: number[] }) =>
      api.post<BreakdownResult>("/api/ai/breakdown", input),
  });
}

export function useAiPlanGoal() {
  return useMutation({
    mutationFn: (input: { goalId: number; materialIds: number[]; userNotes?: string }) =>
      api.post<PlanGoalResult>("/api/ai/plan-goal", input),
  });
}
