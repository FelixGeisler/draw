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
  gold: number;
  goldPaid: boolean;
  goldAwarded: number;
}

/**
 * The dealer's daily challenge (#231, ADR-63): one quiet chip under the Draw
 * page filters. Objective and progress are fully derived server-side; task
 * and timer mutations invalidate ["challenge"], so the chip advances live.
 * `paid` remains XP-row truth; Gold truth is reported independently so legacy
 * and anomalous rows are never presented as a repaired payout.
 */
export function ChallengeChip() {
  const { data } = useQuery({
    queryKey: ["challenge"],
    queryFn: () => api.get<ChallengeState>("/api/challenge"),
    staleTime: 30_000,
  });
  if (!data) return null;

  const anomaly = !data.paid && data.goldPaid;
  const payout = data.paid
    ? data.goldPaid
      ? `+${data.xp} XP · +${data.goldAwarded} Gold`
      : `+${data.xp} XP`
    : anomaly
      ? `inconsistent payout: +${data.goldAwarded} Gold without XP`
      : `${data.progress}/${data.target}`;
  const title = data.paid
    ? data.goldPaid
      ? `Today's challenge complete — +${data.xp} XP · +${data.goldAwarded} Gold banked`
      : `Today's legacy challenge payout — +${data.xp} XP banked`
    : anomaly
      ? `Today's challenge has an inconsistent Gold-only payout`
      : `Today's challenge — worth +${data.xp} XP · +${data.gold} Gold`;

  return (
    <div
      className="chip challenge-chip"
      data-testid="challenge-chip"
      style={
        data.paid || anomaly
          ? { borderColor: "var(--warn)", color: "var(--warn)" }
          : undefined
      }
      title={title}
    >
      {anomaly ? "⚠" : data.paid ? "✔" : "🎲"} Today: {data.label}
      {" · "}
      {payout}
    </div>
  );
}
