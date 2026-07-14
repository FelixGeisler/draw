import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Task } from "../api/types";
import { announceAchievements } from "./useGamification";

export interface DrawResponse {
  task: Task | null;
  reason?: "no_ready_tasks" | "all_too_big";
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
      // Every draw replaces the server-persisted current draw.
      qc.invalidateQueries({ queryKey: ["draw", "current"] });
      announceAchievements(data.newAchievements);
    },
  });
}

/** The server-persisted current draw — lets the DrawPage restore the revealed
 *  card after a reload (issue #25), mirroring the TimerBar restore. */
export function useCurrentDraw() {
  return useQuery({
    queryKey: ["draw", "current"],
    queryFn: () => api.get<{ task: Task } | null>("/api/draw/current"),
  });
}
