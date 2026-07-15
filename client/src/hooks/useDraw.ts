import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Task } from "../api/types";
import { announceAchievements } from "./useGamification";

export interface DrawResponse {
  task: Task | null;
  reason?: "no_ready_tasks" | "all_too_big" | "all_outside_window";
  poolSize?: number;
  probability?: number;
  newAchievements?: string[];
}

export function useDraw() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (filters: { categoryId?: number; goalId?: number }) =>
      api.post<DrawResponse>("/api/draw", filters),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      qc.invalidateQueries({ queryKey: ["gamification"] });
      // The response IS the new server-persisted current draw (ADR-13):
      // written straight into the cache so the derived card (#110) reveals
      // the moment the shuffle ends, then confirmed by an ordinary refetch —
      // which also supersedes any stale GET still in flight.
      qc.setQueryData(["draw", "current"], data.task ? { task: data.task } : null);
      qc.invalidateQueries({ queryKey: ["draw", "current"] });
      announceAchievements(data.newAchievements);
    },
  });
}

/** The server-persisted current draw (ADR-13). The DrawPage DERIVES its
 *  standing card from this continuously (#110): reloads restore the card
 *  (issue #25, mirroring the TimerBar), in-app mutations invalidate it, and
 *  the interval/window-focus refetches surface changes no invalidation can
 *  see (MCP, a second tab) — the card leaves on its own within a minute. */
export function useCurrentDraw() {
  return useQuery({
    queryKey: ["draw", "current"],
    queryFn: () => api.get<{ task: Task } | null>("/api/draw/current"),
    refetchInterval: 60_000,
  });
}

/** Write-through for the current-draw cache, key owned by this module: a
 *  DrawPage mutation whose response already settles the pointer's fate
 *  (complete/snooze/delete cleared it eagerly server-side; an in-deck edit
 *  kept it) shows up instantly instead of one refetch round-trip later. The
 *  invalidation-triggered refetch confirms the same state right after. */
export function useCurrentDrawCache() {
  const qc = useQueryClient();
  return (current: { task: Task } | null) => qc.setQueryData(["draw", "current"], current);
}
