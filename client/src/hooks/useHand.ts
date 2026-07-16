import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Task } from "../api/types";
import { announceAchievements } from "./useGamification";

/** Today's dealt hand (#59, ADR-34) — the morning plan, one per local day. */
export interface Hand {
  /** Server-local day the hand was dealt for; it dies at local midnight. */
  date: string;
  budgetMinutes: number;
  tasks: Task[];
}

export interface DealResponse {
  hand: Hand | null;
  /** Why an empty deal came up empty — the draw's reasons plus the budget's. */
  reason?: "no_ready_tasks" | "all_too_big" | "all_outside_window" | "budget_too_small";
}

/**
 * The server-persisted hand. Like the current draw (#110) this is read
 * continuously rather than snapshotted: completing, snoozing or deleting a
 * hand card on ANY surface shrinks the hand server-side, and the task hooks'
 * invalidation (useTasks) makes the strip drop the card without a second act.
 */
export function useHand() {
  return useQuery({
    queryKey: ["hand"],
    queryFn: () => api.get<Hand | null>("/api/hand"),
  });
}

/** Deal today's hand. Once per local day — a second deal is a 409 server-side
 *  and the UI never offers it (there is no redeal by design, ADR-34). */
export function useDealHand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<DealResponse>("/api/hand/deal", {}),
    onSuccess: (data) => {
      // The response IS the new persisted hand — written through so the strip
      // fills immediately, then confirmed by an ordinary refetch.
      qc.setQueryData(["hand"], data.hand);
      qc.invalidateQueries({ queryKey: ["hand"] });
    },
    // A deal can lose a race: another tab or an MCP deal writes today's hand
    // while this tab still shows the CTA from a stale null cache, and the click
    // takes the route's 409. Refetch so the strip snaps to the server's truth
    // instead of re-enabling the button over a wrong screen.
    onError: () => qc.invalidateQueries({ queryKey: ["hand"] }),
  });
}

/**
 * Play a card from the hand: it becomes the current draw (ADR-13), so this
 * takes the same cache write-through as a draw — the DrawPage's derived card
 * (#110) reveals it with no refetch race. Dealing awarded nothing; PLAYING is
 * the draw, so achievements are announced here.
 */
export function usePlayHandCard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: number) =>
      api.post<{ task: Task; newAchievements?: string[] }>("/api/hand/play", { taskId }),
    onSuccess: (data) => {
      qc.setQueryData(["draw", "current"], { task: data.task });
      qc.invalidateQueries({ queryKey: ["draw", "current"] });
      // The played card is still IN the hand (as the in-play one) — but the
      // refetch keeps the strip honest about the server's pruning.
      qc.invalidateQueries({ queryKey: ["hand"] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
      qc.invalidateQueries({ queryKey: ["gamification"] });
      announceAchievements(data.newAchievements);
    },
  });
}
