import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { announceAchievements } from "./useGamification";
import type {
  Category,
  CompletionResponse,
  NewSubtask,
  NewTask,
  Settings,
  Task,
} from "../api/types";

export function useCategories() {
  return useQuery({
    queryKey: ["categories"],
    queryFn: () => api.get<Category[]>("/api/categories"),
  });
}

export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<Settings>("/api/settings"),
  });
}

export function useTasks(filters?: { status?: string; categoryId?: number; goalId?: number }) {
  const params = new URLSearchParams();
  if (filters?.status) params.set("status", filters.status);
  if (filters?.categoryId) params.set("categoryId", String(filters.categoryId));
  if (filters?.goalId) params.set("goalId", String(filters.goalId));
  const qs = params.toString();
  return useQuery({
    queryKey: ["tasks", qs],
    queryFn: () => api.get<Task[]>(`/api/tasks${qs ? `?${qs}` : ""}`),
  });
}

function useInvalidateTasks() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["tasks"] });
    qc.invalidateQueries({ queryKey: ["gamification"] });
    qc.invalidateQueries({ queryKey: ["stats"] });
  };
}

export function useCreateTask() {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: (task: NewTask) => api.post<Task>("/api/tasks", task),
    onSuccess: invalidate,
  });
}

export function useUpdateTask() {
  const invalidate = useInvalidateTasks();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: number } & Record<string, unknown>) =>
      api.patch<CompletionResponse>(`/api/tasks/${id}`, patch),
    onSuccess: (data) => {
      invalidate();
      // Completing a task may have closed its running timer server-side.
      qc.invalidateQueries({ queryKey: ["timer"] });
      announceAchievements(data.newAchievements);
    },
  });
}

export function useDeleteTask() {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: (id: number) => api.delete<{ ok: boolean }>(`/api/tasks/${id}`),
    onSuccess: invalidate,
  });
}

export function useCreateSubtasks() {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: ({ parentId, subtasks }: { parentId: number; subtasks: NewSubtask[] }) =>
      api.post<Task[]>(`/api/tasks/${parentId}/subtasks`, { subtasks }),
    onSuccess: invalidate,
  });
}
