import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

export interface ActivityCard {
  taskId: number;
  title: string;
  categoryId: number;
  categoryColor: string;
  effortMinutes: number | null;
  /** Live task rating (like title) — with wasDrawn it derives rarity (#62). */
  impact: number;
  trackedMinutes: number;
  /** Upright (completed on this local day) vs face-down (worked, not done). */
  completed: boolean;
  xpAwarded: number;
  wasDrawn: boolean;
}

export interface ActivityDay {
  date: string; // local calendar day, YYYY-MM-DD
  cards: ActivityCard[];
  totals: { started: number; completed: number; minutes: number; xp: number };
}

/** Per-day activity for the Stats page's skyline. from/to are local dates, inclusive. */
export function useActivity(from: string, to: string) {
  return useQuery({
    queryKey: ["activity", from, to],
    queryFn: () => api.get<{ days: ActivityDay[] }>(`/api/activity?from=${from}&to=${to}`),
    // "Load earlier" extends the range: keep the current skyline on screen
    // while the wider window loads instead of flashing empty.
    placeholderData: keepPreviousData,
  });
}
