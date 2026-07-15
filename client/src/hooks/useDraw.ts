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
      // Every draw replaces the server-persisted current draw.
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

/** The server-persisted current draw — lets the DrawPage restore the revealed
 *  card after a reload (issue #25), mirroring the TimerBar restore. */
export function useCurrentDraw() {
  return useQuery({
    queryKey: ["draw", "current"],
    queryFn: () => api.get<{ task: Task; warmup?: WarmupInfo } | null>("/api/draw/current"),
  });
}
