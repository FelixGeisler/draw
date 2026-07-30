import { useActivity } from "../hooks/useActivity";
import { addDays, localToday } from "../lib/localDay";
import { weeklyReport, weekStartOf } from "../lib/weeklyReport";
import "./WeeklyReport.css";

/**
 * The weekly run report (#233, ADR-65): one wide recap card at the top of
 * Stats — a week closed like a pack opened, not a dashboard. Folds the same
 * activity payload the History calendar reads (fourteen days: this Monday
 * week and the seven before it) in a pure lib; renders nothing for a week
 * with no activity, because a recap of nothing is noise.
 */
export function WeeklyReport() {
  const today = localToday();
  const weekStart = weekStartOf(today);
  const activity = useActivity(addDays(weekStart, -7), today);
  if (!activity.data) return null;
  const report = weeklyReport(activity.data.days, today);
  if (!report) return null;

  const delta = (n: number, unit: string) =>
    n === 0 ? `even with last week` : n > 0 ? `▲ ${n} ${unit} vs last week` : `▼ ${-n} ${unit} vs last week`;

  return (
    <section className="week-report panel" data-testid="weekly-report">
      <div className="week-report-heading">This week</div>
      <div className="week-report-stats">
        <div className="week-report-stat">
          <span className="week-report-num">{report.completions}</span>
          <span className="week-report-label">cards done</span>
          <span className="week-report-delta">{delta(report.deltaCompletions, "cards")}</span>
        </div>
        <div className="week-report-stat">
          <span className="week-report-num">{report.minutes}</span>
          {/* Not "minutes tracked" — the summary tile below owns that exact
              text and E2E locators resolve text page-wide (strict mode). */}
          <span className="week-report-label">minutes worked</span>
          <span className="week-report-delta">{delta(report.deltaMinutes, "min")}</span>
        </div>
        <div className="week-report-stat">
          <span className="week-report-num">{report.xp}</span>
          <span className="week-report-label">XP earned</span>
          {(report.holos > 0 || report.silvers > 0) && (
            <span className="week-report-delta week-report-rare">
              {report.holos > 0 && `${report.holos}× holo `}
              {report.silvers > 0 && `${report.silvers}× silver`}
            </span>
          )}
        </div>
        {report.bestDay && (
          <div className="week-report-stat">
            <span className="week-report-num">
              {new Date(`${report.bestDay.date}T00:00:00`).toLocaleDateString(undefined, {
                weekday: "short",
              })}
            </span>
            <span className="week-report-label">best day</span>
            <span className="week-report-delta">{report.bestDay.completions} done</span>
          </div>
        )}
      </div>
    </section>
  );
}
