import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";

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
  /** ACTUAL cost of the turn (output priced in) — the estimate endpoint's estimatedUsd is input-only. */
  costUsd: number;
}

export interface AgentTurnResult {
  sessionId: string;
  reply: string;
  /** version identifies the pending changeset — apply sends it back so a retry of a consumed changeset reconciles (#143). */
  changeset: { version: number; ops: StagedOp[] };
  usage: AgentTurnUsage;
  stopped?: "max_iterations" | "token_budget" | "truncated";
}

export interface AppliedOp {
  draftId: string;
  taskIds: number[];
}

export interface ApplyInput {
  sessionId?: string;
  changesetVersion?: number;
  operations: StagedOp[];
}

export interface ApplyResult {
  created: AppliedOp[];
  /**
   * True when the server answered 409 "already applied" WITH the original
   * mapping (#143): the tasks exist from the first apply — an honest retry
   * reads as success and reconciles instead of duplicating.
   */
  alreadyApplied?: boolean;
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

/** Exported for unit tests (the useAi.ts precedent): the exact options useAgentApply mounts. */
export function agentApplyMutation(qc: QueryClient) {
  return {
    mutationFn: async (input: ApplyInput): Promise<ApplyResult> => {
      try {
        return await api.post<ApplyResult>("/api/ai/agent/apply", input);
      } catch (e) {
        // 409 "already applied" WITH the original mapping IS success (#143):
        // the first apply created the tasks; this retry reconciles. A 409
        // without a mapping stays an error — there is nothing to reconcile with.
        if (e instanceof ApiError && e.status === 409) {
          const created = (e.body as { created?: AppliedOp[] } | null)?.created;
          if (Array.isArray(created)) return { created, alreadyApplied: true };
        }
        throw e;
      }
    },
    // Applying creates tasks (possibly under goals): the same broad
    // invalidation set the task mutations use — new rows change lists, goal
    // counts and (via drawability) the deck-derived surfaces. Runs for the
    // reconciled 409 too — the tasks exist either way.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      qc.invalidateQueries({ queryKey: ["goals"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
      qc.invalidateQueries({ queryKey: ["gamification"] });
      qc.invalidateQueries({ queryKey: ["draw", "current"], refetchType: "all" });
    },
  };
}

export function useAgentApply() {
  const qc = useQueryClient();
  return useMutation(agentApplyMutation(qc));
}
