import { useMutation, useQueryClient } from "@tanstack/react-query";
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
      announceAchievements(data.newAchievements);
    },
  });
}
