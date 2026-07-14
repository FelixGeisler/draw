import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";

export interface AiStatus {
  configured: boolean;
  model: string;
  keySource: "database" | "environment" | null;
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

// Transcription-style generation (#28/#29): statedMinutes/points are the
// material's own data; impact is server-derived from point-rank quintiles and
// flagged "model" when it fell back to the model's suggestion (ADR-14).
export interface GeneratedTaskPart {
  title: string;
  minutes: number;
}

export interface GeneratedTask {
  label: string | null;
  title: string;
  points: number | null;
  statedMinutes: number | null;
  estimatedMinutes: number;
  suggestedImpact: 1 | 2 | 3 | 4 | 5;
  rationale: string;
  parts: GeneratedTaskPart[];
  impact: 1 | 2 | 3 | 4 | 5;
  impactSource: "points" | "model";
}

export interface GenerateTasksResult {
  sourceOverview: string;
  tasks: GeneratedTask[];
  /** Parts cap beat the drawable limit on some item — those parts land in "too big". */
  oversizedParts: boolean;
}

export function useAiStatus() {
  return useQuery({
    queryKey: ["ai-status"],
    queryFn: () => api.get<AiStatus>("/api/ai/status"),
    staleTime: 60_000,
  });
}

export function useSetApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => api.put<AiStatus>("/api/ai/key", { key }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ai-status"] }),
  });
}

export function useRemoveApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<AiStatus>("/api/ai/key"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ai-status"] }),
  });
}

export function useAiEstimate() {
  return useMutation({
    // instruction makes a goal estimate mirror the generate-tasks prompt shape
    // (it is part of what gets token-counted server-side).
    mutationFn: (input: {
      taskId?: number;
      goalId?: number;
      materialIds: number[];
      instruction?: string;
    }) => api.post<AiEstimate>("/api/ai/estimate", input),
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

export function useAiGenerateTasks() {
  return useMutation({
    mutationFn: (input: { goalId: number; materialIds: number[]; instruction: string }) =>
      api.post<GenerateTasksResult>("/api/ai/generate-tasks", input),
  });
}
