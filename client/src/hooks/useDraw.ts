import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Task } from "../api/types";
import { announceAchievements } from "./useGamification";

/** Warm-up deal marker (#57): rides on POST /api/draw/warmup and the
 *  current-draw restore, so the badge and bonus-window hint survive reloads. */
export interface WarmupInfo {
  taskId: number;
  dealtAt: string;
  windowMinutes: number;
}

export interface DrawResponse {
  task: Task | null;
  reason?:
    | "no_ready_tasks"
    | "all_too_big"
    | "all_outside_window"
    | "cooling_down"
    | "warmup_unavailable";
  poolSize?: number;
  probability?: number;
  warmup?: WarmupInfo;
  nextWarmupAt?: string | null;
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

/** The "I can't start" escape hatch (#57): deterministically deal the
 *  smallest eligible card. Only offered on the idle deck — never a re-roll. */
export function useWarmupDraw() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (filters: { categoryId?: number; goalId?: number }) =>
      api.post<DrawResponse>("/api/draw/warmup", filters),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      qc.invalidateQueries({ queryKey: ["gamification"] });
      // A deal persists the same current-draw pointer as a regular draw, so
      // it takes the same write-through: the derived card (#110) reveals the
      // moment the shuffle ends — marker included, so the badge shows without
      // waiting for the confirming refetch.
      qc.setQueryData(
        ["draw", "current"],
        data.task ? { task: data.task, warmup: data.warmup } : null,
      );
      qc.invalidateQueries({ queryKey: ["draw", "current"] });
      // Dealing consumes the one-per-N-hours allowance.
      qc.invalidateQueries({ queryKey: ["draw", "warmup"] });
      announceAchievements(data.newAchievements);
    },
  });
}

/** Whether the warm-up allowance is free, with the next-deal time if not. */
export function useWarmupStatus() {
  return useQuery({
    queryKey: ["draw", "warmup"],
    queryFn: () => api.get<{ available: boolean; nextWarmupAt: string | null }>("/api/draw/warmup"),
  });
}

/** The server-persisted current draw (ADR-13). The DrawPage DERIVES its
 *  standing card from this continuously (#110): reloads restore the card
 *  (issue #25, mirroring the TimerBar), in-app mutations invalidate it, and
 *  the interval/window-focus refetches surface changes no invalidation can
 *  see (MCP, a second tab) — the card leaves on its own within a minute.
 *  Carries the warm-up marker (#57) when the card was warm-up dealt. */
export function useCurrentDraw() {
  return useQuery({
    queryKey: ["draw", "current"],
    queryFn: () => api.get<{ task: Task; warmup?: WarmupInfo } | null>("/api/draw/current"),
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
  return (current: { task: Task; warmup?: WarmupInfo } | null) =>
    qc.setQueryData(["draw", "current"], current);
}
