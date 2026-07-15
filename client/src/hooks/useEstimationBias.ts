import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { CategoryBias } from "../api/types";

/**
 * All-history per-category estimation bias (#55) for the TaskForm hint and
 * anything else that coaches. A dedicated lightweight endpoint rather than
 * the full /api/stats payload: the hint needs one small all-history array,
 * not a range-scoped Stats object per mount. The key nests under "stats" so
 * every existing prefix invalidation (task mutations, timer stop) refreshes
 * the bias for free.
 */
export function useEstimationBias() {
  return useQuery({
    queryKey: ["stats", "estimation-bias"],
    queryFn: () => api.get<CategoryBias[]>("/api/stats/estimation-bias"),
  });
}
