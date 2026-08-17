import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

/**
 * Palette search (#243, ADR-68): the flat result-row payload of
 * GET /api/search — joined category/goal names included, deliberately NOT the
 * Task shape (routes/search.ts documents the divergence). The server owns
 * matching (case- and diacritic-insensitive) and the caps (20 tasks, 10
 * goals); the client never re-filters.
 */
export interface SearchTask {
  id: number;
  title: string;
  status: "open" | "done";
  effortMinutes: number | null;
  categoryId: number;
  categoryName: string;
  categoryColor: string;
  goalId: number | null;
  goalTitle: string | null;
}

export interface SearchGoal {
  id: number;
  title: string;
  status: string;
  openTaskCount: number;
}

export interface SearchResponse {
  tasks: SearchTask[];
  goals: SearchGoal[];
}

export function useSearch(q: string) {
  const trimmed = q.trim();
  return useQuery({
    queryKey: ["search", trimmed],
    queryFn: () => api.get<SearchResponse>(`/api/search?q=${encodeURIComponent(trimmed)}`),
    // The empty query renders the Actions group locally — no request to make.
    enabled: trimmed.length > 0,
    // Keep the previous results on screen while the debounced next query is
    // in flight — the list narrows instead of flickering empty per keystroke.
    placeholderData: keepPreviousData,
  });
}
