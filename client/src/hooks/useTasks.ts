import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
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

/**
 * `options` exists for the DrawPage's held-card watch (#118), which needs the
 * list only WHILE #88's hold stands and wants it on the same 60s cadence the
 * current-draw query uses — so a card resolved from MCP or a second tab
 * releases the hold within the minute ADR-29's amendment already accepts.
 * Every other caller takes the plain, always-on query.
 *
 * `enabled` also takes React Query's callback form (#130): the watch's gate
 * is a verdict over this query's OWN data, so it cannot be a boolean derived
 * from the hook's not-yet-returned result — query-core re-resolves the
 * callback against the query on every state change (and stops the interval
 * on false), which is exactly the gate the DrawPage needs.
 */
export function useTasks(
  filters?: { status?: string; categoryId?: number; goalId?: number },
  options?: Pick<UseQueryOptions<Task[]>, "enabled" | "refetchInterval">,
) {
  const params = new URLSearchParams();
  if (filters?.status) params.set("status", filters.status);
  if (filters?.categoryId) params.set("categoryId", String(filters.categoryId));
  if (filters?.goalId) params.set("goalId", String(filters.goalId));
  const qs = params.toString();
  return useQuery({
    queryKey: ["tasks", qs],
    queryFn: () => api.get<Task[]>(`/api/tasks${qs ? `?${qs}` : ""}`),
    ...options,
  });
}

function useInvalidateTasks() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["tasks"] });
    qc.invalidateQueries({ queryKey: ["gamification"] });
    qc.invalidateQueries({ queryKey: ["stats"] });
    // Completions/reopens/deletes change the skyline's card set (Stats page).
    qc.invalidateQueries({ queryKey: ["activity"] });
    // Task mutations can clear or invalidate the server-persisted current
    // draw (complete/delete clear it, edits can push it out of the deck).
    // refetchType "all": the DrawPage derives its standing card from this
    // query (#110), so the dismissal must reach the cache even while the
    // page is unmounted — remounting must not flash the stale card.
    qc.invalidateQueries({ queryKey: ["draw", "current"], refetchType: "all" });
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
      // A subtask completion can auto-complete its parent (#111, ADR-32) —
      // the parent's fresh achievements ride the same response and deserve
      // the same toast; the invalidations above already repaint the lists.
      announceAchievements([
        ...(data.newAchievements ?? []),
        ...(data.parentCompletion?.newAchievements ?? []),
      ]);
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
  const qc = useQueryClient();
  return useMutation({
    // Split-in-place (#108): replaces a too-big subtask with >= 2 parts as
    // siblings; the original ends archived, so the row disappears from the
    // child list. The parts adopt its created_at: among timestamp-distinct
    // siblings they render in its slot, within a same-timestamp batch group
    // at the group's end (ADR-18).
    mutationFn: ({
      id,
      parts,
    }: {
      id: number;
      parts: { title: string; effortMinutes: number; description?: string }[];
    }) => api.post<Task[]>(`/api/tasks/${id}/split`, { parts }),
    onSuccess: () => {
      invalidate();
      // The split closes a running time entry on the original server-side
      // (ADR-12 mirror) — refresh the TimerBar now instead of letting it
      // show a dead timer until the next 60 s poll.
      qc.invalidateQueries({ queryKey: ["timer"] });
    },
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
