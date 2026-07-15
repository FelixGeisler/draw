import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Task } from "../api/types";

export interface TimerState {
  entry: { id: number; taskId: number; startedAt: string; endedAt: null };
  task: Pick<Task, "id" | "title" | "categoryId" | "impact" | "effortMinutes" | "goalId" | "status">;
}

export function useCurrentTimer() {
  return useQuery({
    queryKey: ["timer"],
    queryFn: () => api.get<TimerState | null>("/api/timer/current"),
    refetchInterval: 60_000,
  });
}

export function useStartTimer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: number) => api.post<{ ok: boolean }>(`/api/tasks/${taskId}/timer/start`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["timer"] });
      // Starting a timer lays a (face-down) card into today's skyline tower.
      qc.invalidateQueries({ queryKey: ["activity"] });
      // Goal cards derive trackedMinutes14d from time_entries (#60), and a
      // running entry already counts toward the window via MINUTES_EXPR.
      qc.invalidateQueries({ queryKey: ["goals"] });
    },
  });
}

export function useStopTimer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<unknown>("/api/timer/stop"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["timer"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
      qc.invalidateQueries({ queryKey: ["activity"] });
      // The TimerBar is global: stopping while the Goals page is mounted must
      // refresh the feasibility chip's trackedMinutes14d pace (#60).
      qc.invalidateQueries({ queryKey: ["goals"] });
    },
  });
}
