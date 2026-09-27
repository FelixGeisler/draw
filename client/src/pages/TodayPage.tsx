import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { DailyOverview, DailyOverviewItem } from "../api/types";
import { useDeleteGoal, useUpdateGoal } from "../hooks/useGoals";
import { useDeleteTask, useUpdateTask } from "../hooks/useTasks";
import { selectOverviewTimezone } from "../lib/dailyOverview";
import "./TodayPage.css";

async function resolveTimezone() {
  let status: unknown = null;
  try {
    const response = await fetch("/api/push/status");
    if (response.ok) status = await response.json();
  } catch {
    // Browser detection is the approved fallback for an unavailable status.
  }
  let detected: unknown;
  try {
    detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    detected = undefined;
  }
  return selectOverviewTimezone(status, detected);
}

function TodayRow({ item }: { item: DailyOverviewItem }) {
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const updateGoal = useUpdateGoal();
  const deleteGoal = useDeleteGoal();
  const [date, setDate] = useState(item.date);
  const [error, setError] = useState<string | null>(null);
  const pending = updateTask.isPending || deleteTask.isPending || updateGoal.isPending || deleteGoal.isPending;

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError((reason as Error).message || "The change could not be saved.");
    }
  }

  const link = item.type === "task"
    ? `/tasks?focus=${item.id}&showDone=1`
    : `/goals?focus=${item.id}`;

  return (
    <li className="today-row" data-overview-type={item.type} data-overview-id={item.id}>
      <div className="today-row-summary">
        <span className="today-type">{item.type === "task" ? "Task" : "Goal"}</span>
        <Link to={link}>{item.title}</Link>
        <time dateTime={item.date}>{item.date}</time>
      </div>
      <div className="today-actions">
        <label>
          <span className="sr-only">{item.type === "task" ? "Due" : "Target"} date for {item.title}</span>
          <input
            type="date"
            value={date}
            disabled={pending}
            onChange={(event) => setDate(event.target.value)}
            aria-label={`${item.type === "task" ? "Due" : "Target"} date for ${item.title}`}
          />
        </label>
        <button
          disabled={pending || date === ""}
          onClick={() => run(() => item.type === "task"
            ? updateTask.mutateAsync({ id: item.id, dueDate: date })
            : updateGoal.mutateAsync({ id: item.id, targetDate: date }))}
        >Save date</button>
        <button
          disabled={pending}
          onClick={() => run(() => item.type === "task"
            ? updateTask.mutateAsync({ id: item.id, dueDate: null })
            : updateGoal.mutateAsync({ id: item.id, targetDate: null }))}
        >Clear date</button>
        {item.type === "task" ? (
          <>
            <button disabled={pending} onClick={() => run(() => updateTask.mutateAsync({ id: item.id, status: "done" }))}>
              Complete
            </button>
            <button disabled={pending} onClick={() => run(() => updateTask.mutateAsync({ id: item.id, status: "archived" }))}>
              Archive
            </button>
            <button
              disabled={pending}
              onClick={() => {
                if (confirm(`Delete "${item.title}"?`)) void run(() => deleteTask.mutateAsync(item.id));
              }}
            >Delete</button>
          </>
        ) : (
          <>
            <button disabled={pending} onClick={() => run(() => updateGoal.mutateAsync({ id: item.id, status: "achieved" }))}>
              Achieved
            </button>
            <button
              disabled={pending}
              onClick={() => {
                if (confirm(`Mark goal "${item.title}" as missed?`)) {
                  void run(() => updateGoal.mutateAsync({ id: item.id, status: "missed" }));
                }
              }}
            >Missed</button>
            <button
              disabled={pending}
              onClick={() => {
                if (confirm(`Drop goal "${item.title}"?`)) {
                  void run(() => updateGoal.mutateAsync({ id: item.id, status: "dropped" }));
                }
              }}
            >Dropped</button>
            <button
              disabled={pending}
              onClick={() => {
                if (confirm(`Delete goal "${item.title}"? Tasks stay, but lose the link.`)) {
                  void run(() => deleteGoal.mutateAsync(item.id));
                }
              }}
            >Delete</button>
          </>
        )}
      </div>
      {error && <div className="today-row-error" role="alert">{error}</div>}
    </li>
  );
}

const SECTIONS = [
  ["overdue", "Overdue"],
  ["today", "Today"],
  ["tomorrow", "Tomorrow"],
] as const;

export function TodayPage() {
  const timezone = useQuery({
    queryKey: ["overview-timezone"],
    queryFn: resolveTimezone,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnMount: "always",
    retry: false,
  });
  const selected = timezone.data?.ok ? timezone.data.timezone : null;
  const overview = useQuery({
    queryKey: ["daily-overview", selected],
    queryFn: () => api.get<DailyOverview>(`/api/daily-overview?timezone=${encodeURIComponent(selected!)}`),
    enabled: selected !== null && !timezone.isFetching,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchInterval: false,
    retry: false,
  });

  useEffect(() => {
    const refetchOnFocus = () => {
      if (selected !== null) void overview.refetch();
    };
    window.addEventListener("focus", refetchOnFocus);
    return () => window.removeEventListener("focus", refetchOnFocus);
  }, [selected, overview.refetch]);

  return (
    <main className="content today-page">
      <h1>Today</h1>
      <p className="today-subtitle">Overdue work and the next two local calendar days.</p>

      {timezone.isPending || timezone.isFetching ? (
        <p role="status">Resolving your timezone…</p>
      ) : timezone.data && !timezone.data.ok ? (
        <div className="panel today-error" role="alert">
          <p>No valid timezone is available. Enable browser timezone detection or save an IANA timezone in Push settings.</p>
          <button onClick={() => timezone.refetch()}>Retry timezone</button>
        </div>
      ) : overview.isPending || overview.isFetching && !overview.data ? (
        <p role="status">Loading daily overview…</p>
      ) : overview.isError ? (
        <div className="panel today-error" role="alert">
          <p>Could not load the daily overview. Your items have not been treated as empty.</p>
          <button onClick={() => overview.refetch()}>Retry overview</button>
        </div>
      ) : overview.data ? (
        <>
          <p className="today-context">
            Local date <strong>{overview.data.localDate}</strong> · {overview.data.timezone}
          </p>
          {SECTIONS.map(([key, title]) => {
            const items = overview.data.groups[key];
            return (
              <section className="today-section panel" key={key} data-overview-group={key}>
                <h2>{title} <span>({items.length})</span></h2>
                {items.length === 0 ? (
                  <p className="today-empty">Nothing {key === "overdue" ? "overdue" : `due ${key}`}.</p>
                ) : (
                  <ul>{items.map((item) => <TodayRow key={`${item.type}-${item.id}`} item={item} />)}</ul>
                )}
              </section>
            );
          })}
          {overview.data.counts.overdue + overview.data.counts.today + overview.data.counts.tomorrow === 0 && (
            <p className="today-all-empty">Nothing is overdue, due today, or due tomorrow.</p>
          )}
        </>
      ) : null}
    </main>
  );
}
