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
    // Completions/reopens/deletes change the History skyline's card set.
    qc.invalidateQueries({ queryKey: ["activity"] });
    // Task mutations can clear or invalidate the server-persisted current
    // draw (complete/delete clear it, edits can push it out of the deck).
    qc.invalidateQueries({ queryKey: ["draw", "current"] });
    // Goal cards derive taskCount/doneCount from tasks — keep them in sync.
    qc.invalidateQueries({ queryKey: ["goals"] });
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

export function useSplitTask() {
  const invalidate = useInvalidateTasks();
  return useMutation({
    // Split-in-place (#108): replaces a too-big subtask with >= 2 parts as
    // siblings; the original ends archived, so the row disappears from the
    // child list and the parts render in its queue slot (ADR-18).
    mutationFn: ({
      id,
      parts,
    }: {
      id: number;
      parts: { title: string; effortMinutes: number; description?: string }[];
    }) => api.post<Task[]>(`/api/tasks/${id}/split`, { parts }),
    onSuccess: invalidate,
  });
}

export function useCreateSubtasks() {
  const invalidate = useInvalidateTasks();
  return useMutation({
    // orderMode (#23) persists "do in order" on the parent in the same
    // transaction as the batch; omitted = leave the parent's mode untouched.
    mutationFn: ({
      parentId,
      subtasks,
      orderMode,
    }: {
      parentId: number;
      subtasks: NewSubtask[];
      orderMode?: Task["subtaskOrderMode"];
    }) => api.post<Task[]>(`/api/tasks/${parentId}/subtasks`, { subtasks, orderMode }),
    onSuccess: invalidate,
  });
}
