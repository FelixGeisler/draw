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
    onSuccess: () => qc.invalidateQueries({ queryKey: ["timer"] }),
  });
}

export function useStopTimer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<unknown>("/api/timer/stop"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["timer"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
    },
  });
}
