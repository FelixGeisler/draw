import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "../api/client";

export interface GamificationState {
  xp: number;
  /** Unclamped server-derived total from all three Gold owners. */
  totalGold: number;
  level: number;
  levelProgress: { intoLevel: number; needed: number };
  /** Real completion days in the unbroken run — rest/frozen days never count. */
  streak: number;
  todayKind: "completed" | "pending" | "rest";
  freezesBanked: number;
  freezeBankCap: number;
  /** Local days ("YYYY-MM-DD") a consumed freeze covered, most recent first. */
  frozenDays: string[];
  /** Rest days without a completion inside the run, most recent first. */
  restDays: string[];
  dailyGoalMet: boolean;
  dailyGoal: number;
  todayCompletions: {
    id: number;
    completedAt: string;
    wasDrawn: number;
    xpAwarded: number;
    goldAwarded: number;
    taskId: number;
    title: string;
    categoryId: number;
    /** Goal link (#115), kept on the payload through the #123 redesign —
     *  currently unused by the pile UI. */
    goalId: number | null;
    impact: number;
  }[];
  achievements: {
    key: string;
    /** Display title — the user's override (#177) COALESCE'd onto the default. */
    title: string;
    emoji: string;
    /** Display description — the user's override (#177) or the default. */
    description: string;
    /** Display curation (#177): hidden cards move to the Stats "Hidden" section;
     *  hiding never affects unlock/claim/XP — a hidden card still unlocks. */
    hidden: boolean;
    /** Any display override is set (title/description/hidden) — gates the card's
     *  "Reset to default" affordance (#177). */
    customized: boolean;
    unlockedAt: string | null;
    /** Claim-for-XP (#156): the moment this achievement was claimed, or null
     *  when unlocked-but-unclaimed (claimable) or still locked. */
    claimedAt: string | null;
    /** The XP stamped at claim time, or null until claimed. */
    claimXp: number | null;
    /** Chain progress toward the next threshold, or null for a one-off. */
    progress: { current: number; target: number } | null;
  }[];
}

export function useGamification() {
  return useQuery({
    queryKey: ["gamification"],
    queryFn: () => api.get<GamificationState>("/api/gamification"),
  });
}

export interface ClaimResponse {
  xpAwarded: number;
  levelUp: boolean;
  /** Achievements the claim's XP unlocked in the same transaction (a level
   *  crossing, #156) — toasted like any other unlock. */
  newAchievements: string[];
}

/**
 * Claim an unlocked achievement for XP (#156). On success the gamification
 * query is invalidated so the header XP/level and the card's claimed state
 * refresh from the server — the client never computes the new total itself.
 */
export function useClaimAchievement() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => api.post<ClaimResponse>(`/api/achievements/${key}/claim`, {}),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["gamification"] });
      // A claim can tip the level bar and unlock the level_N card — announce
      // it so the toast fires just as it would for a draw/completion unlock.
      announceAchievements(data.newAchievements);
    },
  });
}

/** A display override (#177): the fields PATCH /api/achievements/:key accepts.
 *  title/description = null clears that override (default restored). */
export interface UpdateAchievementInput {
  key: string;
  title?: string | null;
  description?: string | null;
  hidden?: boolean;
}

/**
 * The update-achievement mutation options, factored out (the agentApplyMutation
 * precedent) so the PATCH + invalidation can be exercised through query-core's
 * MutationObserver without a renderer — the client suite has no DOM.
 */
export function updateAchievementMutation(queryClient: QueryClient) {
  return {
    mutationFn: ({ key, ...patch }: UpdateAchievementInput) =>
      api.patch(`/api/achievements/${key}`, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["gamification"] });
    },
  };
}

/**
 * Edit an achievement's DISPLAY metadata — rename, rewrite the description, hide
 * (#177). Display-only: unlock, claim, XP and rarity are untouched server-side.
 * On success the gamification query is invalidated so the collection, the header
 * and any open toast re-read the COALESCE'd title/description — the client never
 * computes the merged values itself.
 */
export function useUpdateAchievement() {
  const queryClient = useQueryClient();
  return useMutation(updateAchievementMutation(queryClient));
}

/** Broadcast newly unlocked achievements so the global toast can render them. */
export function announceAchievements(keys: string[] | undefined) {
  if (keys && keys.length > 0) {
    window.dispatchEvent(new CustomEvent("achievements-unlocked", { detail: keys }));
  }
}
