import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

interface ChallengeState {
  day: string;
  key: string;
  label: string;
  target: number;
  progress: number;
  completed: boolean;
  paid: boolean;
  xp: number;
}

/**
 * The dealer's daily challenge (#231, ADR-63): one quiet chip under the Draw
 * page filters. Objective and progress are fully derived server-side; task
 * and timer mutations invalidate ["challenge"], so the chip advances live.
 * Paid = gold — the +50 landed in the ledger, exactly once per local day.
 */
export function ChallengeChip() {
  const { data } = useQuery({
    queryKey: ["challenge"],
    queryFn: () => api.get<ChallengeState>("/api/challenge"),
    staleTime: 30_000,
  });
  if (!data) return null;

  return (
    <div
      className="chip challenge-chip"
      data-testid="challenge-chip"
      style={
        data.paid
          ? { borderColor: "var(--warn)", color: "var(--warn)" }
          : undefined
      }
      title={
        data.paid
          ? `Today's challenge complete — +${data.xp} XP banked`
          : `Today's challenge — worth +${data.xp} XP`
      }
    >
      {data.paid ? "✔" : "🎲"} Today: {data.label}
      {" · "}
      {data.paid ? `+${data.xp} XP` : `${data.progress}/${data.target}`}
    </div>
  );
}
