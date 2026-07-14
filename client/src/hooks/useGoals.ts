import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Goal, Material } from "../api/types";

export function useGoals(status: string = "active") {
  return useQuery({
    queryKey: ["goals", status],
    queryFn: () => api.get<Goal[]>(`/api/goals?status=${status}`),
  });
}

export function useCreateGoal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (goal: { title: string; outcome?: string; targetDate?: string | null }) =>
      api.post<Goal>("/api/goals", goal),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["goals"] }),
  });
}

export function useUpdateGoal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: number } & Record<string, unknown>) =>
      api.patch<Goal>(`/api/goals/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["goals"] }),
  });
}

export function useDeleteGoal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<{ ok: boolean }>(`/api/goals/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["goals"] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
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
