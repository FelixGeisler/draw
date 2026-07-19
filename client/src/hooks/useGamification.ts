import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";

export interface GamificationState {
  xp: number;
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
    title: string;
    emoji: string;
    description: string;
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

/** Broadcast newly unlocked achievements so the global toast can render them. */
export function announceAchievements(keys: string[] | undefined) {
  if (keys && keys.length > 0) {
    window.dispatchEvent(new CustomEvent("achievements-unlocked", { detail: keys }));
  }
}
