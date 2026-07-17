import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";

// The conversational assistant (#31, ADR-37). Server-state via mutations only
// — a conversation is scratch state and deliberately not persisted anywhere
// (an in-memory session server-side, component state client-side): a reload
// starts fresh, and a server restart surfaces as "start a new conversation".

export interface StagedTaskInput {
  title: string;
  categoryId: number;
  description?: string;
  goalId?: number;
  impact?: 1 | 2 | 3 | 4 | 5;
  effortMinutes?: number;
  dueDate?: string;
  recurEveryDays?: number;
  windowDays?: number[];
  windowStart?: string;
  windowEnd?: string;
  /** A real task id, or the draftId of a task staged earlier in the changeset. */
  parentId?: number | string;
}

export interface StagedSubtask {
  draftId: string;
  title: string;
  description?: string;
  effortMinutes?: number;
  impact?: 1 | 2 | 3 | 4 | 5;
}

export type StagedOp =
  | { kind: "create_task"; draftId: string; task: StagedTaskInput }
  | { kind: "create_subtasks"; draftId: string; parentId: number | string; subtasks: StagedSubtask[] };

export interface AgentTurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  estimatedUsd: number;
}

export interface AgentTurnResult {
  sessionId: string;
  reply: string;
  changeset: { ops: StagedOp[] };
  usage: AgentTurnUsage;
  stopped?: "max_iterations" | "token_budget";
}

export interface AppliedOp {
  draftId: string;
  taskIds: number[];
}

export function useAgentEstimate() {
  return useMutation({
    mutationFn: (input: { goalId?: number; materialIds?: number[]; message: string }) =>
      api.post<{ inputTokens: number; estimatedUsd: number }>("/api/ai/agent/estimate", input),
  });
}

export function useAgentMessage() {
  return useMutation({
    mutationFn: (input: {
      sessionId?: string;
      goalId?: number;
      materialIds?: number[];
      message: string;
    }) => api.post<AgentTurnResult>("/api/ai/agent/message", input),
  });
}

export function useAgentApply() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { sessionId?: string; operations: StagedOp[] }) =>
      api.post<{ created: AppliedOp[] }>("/api/ai/agent/apply", input),
    // Applying creates tasks (possibly under goals): the same broad
    // invalidation set the task mutations use — new rows change lists, goal
    // counts and (via drawability) the deck-derived surfaces.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      qc.invalidateQueries({ queryKey: ["goals"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
      qc.invalidateQueries({ queryKey: ["gamification"] });
      qc.invalidateQueries({ queryKey: ["draw", "current"], refetchType: "all" });
      qc.invalidateQueries({ queryKey: ["hand"], refetchType: "all" });
    },
  });
}
