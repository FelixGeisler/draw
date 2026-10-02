import type { EffortProgressState } from "../lib/effortProgress";
import "./EffortProgress.css";

/** Completed estimated work, presented without changing goal feasibility. */
export function EffortProgress({ progress }: { progress: EffortProgressState }) {
  return (
    <div className="effort-progress" data-testid="effort-progress">
      <div
        className="effort-progress-track"
        role="progressbar"
        aria-label="Effort progress"
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.completed}
      >
        <div
          className="effort-progress-fill"
          data-testid="effort-progress-fill"
          style={{ width: `${progress.pct * 100}%` }}
        />
      </div>
      <span className="effort-progress-caption">
        {progress.completed}/{progress.total} min complete
      </span>
    </div>
  );
}
