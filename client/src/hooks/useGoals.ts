import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import { api } from "../api/client";
import type { Goal, Material } from "../api/types";
import { announceAchievements } from "./useGamification";

export function useGoals(
  status: string = "active",
  options?: Pick<UseQueryOptions<Goal[]>, "enabled">,
) {
  return useQuery({
    queryKey: ["goals", status],
    queryFn: ({ signal }) => api.get<Goal[]>(`/api/goals?status=${status}`, signal),
    ...options,
  });
}

export function useCreateGoal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (goal: { title: string; outcome?: string; targetDate?: string | null }) =>
      api.post<Goal>("/api/goals", goal),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["goals"] });
      qc.invalidateQueries({ queryKey: ["daily-overview"] });
    },
  });
}

export function useUpdateGoal() {
  const qc = useQueryClient();
  return useMutation({
    // The PATCH response optionally carries newAchievements (#145): achieving
    // the first goal ever unlocks first_goal server-side, delivered on the
    // same additive response field as the draw/tasks routes.
    mutationFn: ({ id, ...patch }: { id: number } & Record<string, unknown>) =>
      api.patch<Goal & { newAchievements?: string[] }>(`/api/goals/${id}`, patch),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["goals"] });
      qc.invalidateQueries({ queryKey: ["daily-overview"] });
      announceAchievements(data.newAchievements);
      if (data.newAchievements?.length) qc.invalidateQueries({ queryKey: ["gamification"] });
    },
  });
}

export function deleteGoalMutation(qc: QueryClient) {
  return {
    mutationFn: (id: number) => api.delete<{ ok: boolean }>(`/api/goals/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["goals"] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
      qc.invalidateQueries({ queryKey: ["daily-overview"] });
    },
  };
}

export function useDeleteGoal() {
  const qc = useQueryClient();
  return useMutation(deleteGoalMutation(qc));
}

export function useMaterials(goalId: number) {
  return useQuery({
    queryKey: ["materials", goalId],
    queryFn: () => api.get<Material[]>(`/api/goals/${goalId}/materials`),
  });
}

export function useAddMaterial(goalId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { file?: File; noteText?: string }) => {
      if (input.file) {
        const form = new FormData();
        form.append("file", input.file);
        const res = await fetch(`/api/goals/${goalId}/materials`, { method: "POST", body: form });
        if (!res.ok) throw new Error((await res.json()).error ?? "upload failed");
        return res.json() as Promise<Material>;
      }
      return api.post<Material>(`/api/goals/${goalId}/materials`, { noteText: input.noteText });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["materials", goalId] });
      qc.invalidateQueries({ queryKey: ["goals"] });
    },
  });
}

export function useDeleteMaterial(goalId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<{ ok: boolean }>(`/api/materials/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["materials", goalId] });
      qc.invalidateQueries({ queryKey: ["goals"] });
    },
  });
}
