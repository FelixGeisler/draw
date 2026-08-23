import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
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
      // Starting a timer lights up today's cell in the History calendar (Stats).
      qc.invalidateQueries({ queryKey: ["activity"] });
      // Goal cards derive trackedMinutes14d from time_entries (#60), and a
      // running entry already counts toward the window via MINUTES_EXPR.
      qc.invalidateQueries({ queryKey: ["goals"] });
    },
  });
}

export function stopTimerMutation(qc: QueryClient) {
  return {
    mutationFn: () => api.post<unknown>("/api/timer/stop"),
    // onSettled, not onSuccess (PR #105 review): a Stop that races a second
    // tab hits an already-closed timer and 404s — the refetch must still
    // happen so `["timer"]` returns null and the focus overlay collapses to
    // the revealed card immediately (ADR-29: never a dead overlay) instead
    // of counting down a dead entry until the next interval tick.
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["timer"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
      qc.invalidateQueries({ queryKey: ["activity"] });
      // A stop can land the track challenge's payout (#231) — refresh the
      // chip and the XP header together.
      qc.invalidateQueries({ queryKey: ["challenge"] });
      qc.invalidateQueries({ queryKey: ["gamification"] });
      qc.invalidateQueries({ queryKey: ["shop"] });
      // The TimerBar is global: stopping while the Goals page is mounted must
      // refresh the feasibility chip's trackedMinutes14d pace (#60).
      qc.invalidateQueries({ queryKey: ["goals"] });
      // The draw payloads carry trackedMinutes (sum of CLOSED entries,
      // server-derived); fold the just-closed entry into the cached copy so
      // the payload stays truthful for any consumer even though the on-card
      // DEF stat died with the TCG frame (#123).
      qc.invalidateQueries({ queryKey: ["draw", "current"] });
    },
  };
}

export function useStopTimer() {
  const qc = useQueryClient();
  return useMutation(stopTimerMutation(qc));
}
