import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

export interface GamificationState {
  xp: number;
  level: number;
  levelProgress: { intoLevel: number; needed: number };
  streak: number;
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
    impact: number;
  }[];
  achievements: {
    key: string;
    title: string;
    emoji: string;
    description: string;
    unlockedAt: string | null;
  }[];
}

export function useGamification() {
  return useQuery({
    queryKey: ["gamification"],
    queryFn: () => api.get<GamificationState>("/api/gamification"),
  });
}

/** Broadcast newly unlocked achievements so the global toast can render them. */
export function announceAchievements(keys: string[] | undefined) {
  if (keys && keys.length > 0) {
    window.dispatchEvent(new CustomEvent("achievements-unlocked", { detail: keys }));
  }
}
