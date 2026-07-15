import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { batchArtKey } from "../lib/cardVisuals";

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
  /** #23: the model's judgment on whether its execution sequence is binding —
   *  pre-sets the "Do in order" toggle; the user has the last word. */
  orderMatters: boolean;
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

/**
 * Card-back artwork for a drawn task (#27). Fetches only once the card is
 * revealed, and never blocks the reveal — the card renders instantly with the
 * default gradient and the art fades in if/when it arrives. Every failure,
 * including the 503 ai_not_configured degraded mode, resolves to "no art":
 * no retry storm, no toast, no error UI (callers read only `data`).
 */
export function useCardArt(taskId: number | undefined, revealed: boolean) {
  return useQuery({
    queryKey: ["card-art", taskId],
    queryFn: () => api.get<{ svg: string }>(`/api/tasks/${taskId}/card-art`),
    enabled: revealed && taskId != null,
    // The server caches at most one artwork per task — it cannot go stale.
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/**
 * Batch card art for the trophy pile (#114): ONE cache-only round trip for
 * all of today's completions — the endpoint never generates, so rendering
 * the pile can never trigger a Claude call (with or without a key). Absent
 * rows simply keep the gradient face. The key is deduped + sorted
 * (batchArtKey), so completion order can't mint duplicate cache entries, and
 * a new completion changes the id set and refetches naturally. Same silent
 * contract as useCardArt: failures resolve to "no art", callers read only
 * `data`.
 */
export function useCardArtBatch(taskIds: number[]) {
  const key = batchArtKey(taskIds);
  return useQuery({
    queryKey: ["card-art-batch", key],
    queryFn: () =>
      api.get<{ arts: { taskId: number; svg: string }[] }>(`/api/card-art?taskIds=${key}`),
    enabled: key !== "",
    // Cached art only changes through a regenerate on the DRAWN card — but a
    // recurring task completed earlier today can be redrawn the same day, so
    // the regenerate mutation invalidates this key; nothing else can stale it.
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/**
 * Regenerate the card art (#113): the server generates -> sanitizes ->
 * REPLACES the cached row; a failure keeps the old art. Same silent contract
 * as useCardArt — callers read only isPending, never error state, so a 503
 * (degraded) or 502 (bad generation) shows nothing. On success the response
 * is written straight into the card-art cache (staleTime: Infinity means the
 * query itself never refetches), which swaps the art in without a second GET.
 *
 * The task id is a mutation VARIABLE (`mutate(taskId)`), never a hook
 * argument: React Query v5 re-binds a pending mutation's options — and with
 * them any id captured in the onSuccess closure — on every re-render, so a
 * regenerate resolving after the drawn task changed would write task A's art
 * under task B's cache key (pinned for the session by staleTime: Infinity).
 * Variables are captured at mutate() time and handed back to onSuccess, so
 * the write stays keyed to the task that was actually regenerated. Exported
 * separately from the hook so the contract is testable without a DOM.
 */
export function regenerateCardArtMutation(qc: QueryClient) {
  return {
    mutationFn: (taskId: number) =>
      api.post<{ svg: string }>(`/api/tasks/${taskId}/card-art/regenerate`),
    onSuccess: (data: { svg: string }, taskId: number) => {
      qc.setQueryData(["card-art", taskId], data);
      // A recurring task completed earlier today sits in the trophy pile AND
      // re-enters the pool — regenerating its art on a same-day redraw must
      // refresh the pile's batch cache too (staleTime: Infinity means nothing
      // else ever will). Cheap: the batch endpoint is cache-only server-side,
      // so the refetch is a plain SELECT, never a Claude call.
      void qc.invalidateQueries({ queryKey: ["card-art-batch"] });
    },
  };
}

export function useRegenerateCardArt() {
  const qc = useQueryClient();
  return useMutation(regenerateCardArtMutation(qc));
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
