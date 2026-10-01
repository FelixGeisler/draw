import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { WeekRecord, WeekResponse, WeekValidationContext } from "../../../shared/weekContract";
import { SCHEDULE_TIME_ZONES } from "../../../shared/scheduleTimezones";
import { useUpdateTask } from "../hooks/useTasks";
import { useStartTimer, useStopTimer } from "../hooks/useTimer";
import {
  addWeekDays,
  appendWeekPage,
  createWeekContext,
  formatLocalDateTimeInput,
  formatWeekDay,
  formatWeekTime,
  layoutWeekIntervals,
  mondayForInstant,
  selectWeekTimezone,
  weekIdentity,
  weekRecordTuple,
} from "../lib/week";
import { fetchWeekPage, WeekRequestError, type WeekFailureCode } from "../services/week";
import "./WeekView.css";

const TIMEZONE_ERROR = "Week needs a supported calendar time zone. Set a supported canonical time zone in Push settings or use a browser that reports one, then retry.";

interface WeekLoadState {
  response: WeekResponse | null;
  loading: boolean;
  invalidating: boolean;
  error: { code: WeekFailureCode; failedCursor: string | null } | null;
}

function detectedTimezone(): unknown {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; }
}

async function readTimezone(signal: AbortSignal) {
  let status: unknown = null;
  try {
    const response = await fetch("/api/push/status", { cache: "no-store", signal });
    if (response.ok) status = await response.json() as unknown;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    // Browser detection is the approved fallback for an unavailable status.
  }
  return selectWeekTimezone(status, detectedTimezone());
}

function failureCopy(code: WeekFailureCode): { heading: string; detail: string } {
  switch (code) {
    case "invalid-week-request":
      return { heading: "Week request rejected", detail: "The server rejected this Week page. Retry to request a fresh page." };
    case "week-projection-busy":
      return { heading: "Week is busy", detail: "Another Week read is still running. Retry this page explicitly." };
    case "week-index-unavailable":
      return { heading: "Week index unavailable", detail: "The Week index is not ready. Nothing has been treated as an empty Week." };
    case "week-projection-failed":
      return { heading: "Week projection failed", detail: "The server could not produce this Week page. Retry it explicitly." };
    case "invalid-week-response":
      return { heading: "Invalid Week response", detail: "The complete page failed validation and no records from it were accepted." };
    case "week-network-failed":
      return { heading: "Week network request failed", detail: "The page could not be loaded. Retry it explicitly." };
  }
}

function routeWithWeek(location: ReturnType<typeof useLocation>, week: string): string {
  const params = new URLSearchParams(location.search);
  params.set("view", "week");
  params.set("week", week);
  params.delete("focus");
  params.delete("showDone");
  return `${location.pathname}?${params}${location.hash}`;
}

function TruncatedIndicator({ truncated }: { truncated: boolean }) {
  return truncated ? <span className="week-title-truncated" aria-label="Title truncated">Title truncated</span> : null;
}

interface FixedEditorProps {
  record: Extract<WeekRecord, { kind: "task" }>;
  timezone: string;
  disabled: boolean;
  onSave: (fixedSlot: { startLocal: string; endLocal: string; entryTimezone: string }) => Promise<void>;
  onCancel: () => void;
}

function WeekFixedEditor({ record, timezone, disabled, onSave, onCancel }: FixedEditorProps) {
  const fixed = record.fixed!;
  const [startLocal, setStartLocal] = useState(() => formatLocalDateTimeInput(fixed.startsAt, timezone));
  const [endLocal, setEndLocal] = useState(() => formatLocalDateTimeInput(fixed.endsAt, timezone));
  const [entryTimezone, setEntryTimezone] = useState(timezone);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="week-fixed-editor"
      aria-label={`Edit fixed time for ${record.title}`}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!startLocal || !endLocal || !entryTimezone) return;
        setError(null);
        try { await onSave({ startLocal, endLocal, entryTimezone }); }
        catch (reason) { setError((reason as Error).message || "The fixed time could not be saved."); }
      }}
    >
      <label>Start<input type="datetime-local" value={startLocal} disabled={disabled} onChange={(event) => setStartLocal(event.target.value)} required /></label>
      <label>End<input type="datetime-local" value={endLocal} disabled={disabled} onChange={(event) => setEndLocal(event.target.value)} required /></label>
      <label>Entry timezone<select value={entryTimezone} disabled={disabled} onChange={(event) => setEntryTimezone(event.target.value)} required>
        {SCHEDULE_TIME_ZONES.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
      </select></label>
      <span className="week-fixed-editor-actions">
        <button type="submit" className="primary" disabled={disabled}>Save fixed</button>
        <button type="button" disabled={disabled} onClick={onCancel}>Cancel</button>
      </span>
      {error && <span role="alert" className="week-action-error">{error}</span>}
    </form>
  );
}

interface WeekRecordCardProps {
  record: WeekRecord;
  context: WeekValidationContext;
  disabled: boolean;
  runTaskUpdate: (id: number, patch: Record<string, unknown>) => Promise<void>;
  runStart: (taskId: number) => Promise<void>;
  runStop: () => Promise<void>;
}

function WeekRecordCard({ record, context, disabled, runTaskUpdate, runStart, runStop }: WeekRecordCardProps) {
  const [editingFixed, setEditingFixed] = useState(false);
  const anchor = weekRecordTuple(record, context)[0];
  const anchorDay = context.dates.find((_, index) =>
    anchor >= Date.parse(context.midnightInstants[index]) && anchor < Date.parse(context.midnightInstants[index + 1]),
  ) ?? context.weekStart;
  const taskId = record.kind === "tracked" ? record.taskId : record.kind === "task" ? record.id : null;
  const linked = record.kind !== "tracked" || record.taskStatus !== "archived";
  const title = record.kind === "goal" ? (
    <Link to={`/goals?focus=${record.id}`}>{record.title}</Link>
  ) : linked ? (
    <Link to={`/tasks?focus=${taskId}&showDone=1`}>{record.title}</Link>
  ) : <span>{record.title}</span>;

  const actions = record.kind === "task"
    ? record.status === "open"
      ? { complete: true, reopen: false, start: true, stop: false }
      : { complete: false, reopen: true, start: false, stop: false }
    : record.kind === "tracked"
      ? record.taskStatus === "open"
        ? { complete: true, reopen: false, start: true, stop: record.running }
        : record.taskStatus === "done"
          ? { complete: false, reopen: true, start: false, stop: record.running }
          : { complete: false, reopen: false, start: false, stop: record.running }
      : { complete: false, reopen: false, start: false, stop: false };

  return (
    <li className="week-record" data-week-identity={weekIdentity(record)} data-week-anchor-date={anchorDay}>
      <article>
        <header>
          <span className={`week-kind week-kind-${record.kind}`}>{record.kind === "tracked" ? "Tracked" : record.kind === "goal" ? "Deadline" : record.fixed ? "Fixed" : "Deadline"}</span>
          <strong>{title}</strong>
          <TruncatedIndicator truncated={record.titleTruncated} />
          <time dateTime={anchorDay}>{formatWeekDay(anchorDay, context.timezone)}</time>
        </header>
        <div className="week-record-facts">
          {record.kind === "task" && record.fixed && (
            <span><b>Fixed</b> {formatWeekTime(record.fixed.startsAt, context.timezone)}–{formatWeekTime(record.fixed.endsAt, context.timezone)}
              {record.fixed.contextDate !== null && <> · source date {record.fixed.contextDate}</>}</span>
          )}
          {record.kind === "tracked" && (
            <span><b>Tracked</b> {formatWeekTime(record.startedAt, context.timezone)}–{formatWeekTime(record.effectiveEndAt, context.timezone)}{record.running && " · running"}</span>
          )}
          {record.kind === "task" && record.deadline && <span><b>Deadline</b> <time dateTime={record.deadline.date}>{record.deadline.date}</time></span>}
          {record.kind === "goal" && <span><b>Deadline</b> <time dateTime={record.deadline.date}>{record.deadline.date}</time></span>}
        </div>
        {record.kind !== "goal" && (
          <div className="week-record-actions" aria-label={`Actions for ${record.title}`}>
            {actions.complete && <button disabled={disabled} onClick={() => runTaskUpdate(taskId!, { status: "done" })}>Complete</button>}
            {actions.reopen && <button disabled={disabled} onClick={() => runTaskUpdate(taskId!, { status: "open" })}>Reopen</button>}
            {actions.start && <button disabled={disabled} onClick={() => runStart(taskId!)}>Start now</button>}
            {actions.stop && <button disabled={disabled} onClick={runStop}>Stop</button>}
            {record.kind === "task" && record.fixed && (
              <>
                <button disabled={disabled} onClick={() => setEditingFixed((value) => !value)}>Edit fixed</button>
                <button disabled={disabled} onClick={() => runTaskUpdate(record.id, { fixedSlot: null })}>Remove fixed</button>
              </>
            )}
          </div>
        )}
        {editingFixed && record.kind === "task" && record.fixed && (
          <WeekFixedEditor
            record={record}
            timezone={context.timezone}
            disabled={disabled}
            onCancel={() => setEditingFixed(false)}
            onSave={async (fixedSlot) => {
              await runTaskUpdate(record.id, { fixedSlot });
              setEditingFixed(false);
            }}
          />
        )}
      </article>
    </li>
  );
}

export function WeekView({ routeWeek, now = () => new Date() }: { routeWeek: string | null; now?: () => Date }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [timezoneAttempt, setTimezoneAttempt] = useState(0);
  const [timezone, setTimezone] = useState<{ pending: boolean; value: string | null }>({ pending: true, value: null });
  const [load, setLoad] = useState<WeekLoadState>({ response: null, loading: false, invalidating: false, error: null });
  const loadRef = useRef(load);
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const autoResetUsedRef = useRef(false);
  const contextRef = useRef<WeekValidationContext | null>(null);
  const updateTask = useUpdateTask();
  const startTimer = useStartTimer();
  const stopTimer = useStopTimer();
  const [action, setAction] = useState<{ identity: string; error: string | null } | null>(null);

  useEffect(() => { loadRef.current = load; }, [load]);

  useEffect(() => {
    const controller = new AbortController();
    setTimezone({ pending: true, value: null });
    void readTimezone(controller.signal).then((selection) => {
      if (!controller.signal.aborted) setTimezone({ pending: false, value: selection.ok ? selection.timezone : null });
    }).catch((error) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) setTimezone({ pending: false, value: null });
    });
    return () => controller.abort();
  }, [timezoneAttempt]);

  const canonicalWeek = useMemo(() => {
    if (!timezone.value) return null;
    if (routeWeek && createWeekContext(routeWeek, timezone.value)) return routeWeek;
    return mondayForInstant(now(), timezone.value);
  }, [routeWeek, timezone.value, now]);
  const context = useMemo(
    () => canonicalWeek && timezone.value ? createWeekContext(canonicalWeek, timezone.value) : null,
    [canonicalWeek, timezone.value],
  );
  contextRef.current = context;

  useEffect(() => {
    if (canonicalWeek && routeWeek !== canonicalWeek) {
      navigate(routeWithWeek(location, canonicalWeek), { replace: true });
    }
  }, [canonicalWeek, routeWeek, navigate, location]);

  const runFirstPage = useCallback(async (
    activeContext: WeekValidationContext,
    generation: number,
    invalidating: boolean,
  ) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setLoad({ response: null, loading: true, invalidating, error: null });
    try {
      const page = await fetchWeekPage(activeContext, null, controller.signal);
      if (generationRef.current !== generation || controller.signal.aborted) return;
      setLoad({ response: page, loading: false, invalidating: false, error: null });
    } catch (reason) {
      if (controller.signal.aborted || generationRef.current !== generation) return;
      const code = reason instanceof WeekRequestError ? reason.code : "week-network-failed";
      setLoad({ response: null, loading: false, invalidating: false, error: { code, failedCursor: null } });
    }
  }, []);

  const resetGeneration = useCallback((activeContext: WeekValidationContext, invalidating = false) => {
    abortRef.current?.abort();
    generationRef.current += 1;
    autoResetUsedRef.current = invalidating;
    void runFirstPage(activeContext, generationRef.current, invalidating);
  }, [runFirstPage]);

  useEffect(() => {
    if (!context) {
      abortRef.current?.abort();
      generationRef.current += 1;
      setLoad({ response: null, loading: false, invalidating: false, error: null });
      return;
    }
    resetGeneration(context);
    return () => abortRef.current?.abort();
  }, [context?.weekStart, context?.timezone, resetGeneration]);

  const loadMore = useCallback(async () => {
    const activeContext = contextRef.current;
    const current = loadRef.current.response;
    const cursor = current?.nextCursor ?? null;
    if (!activeContext || !current || cursor === null || loadRef.current.loading) return;
    const generation = generationRef.current;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setLoad((state) => ({ ...state, loading: true, error: null }));
    try {
      const page = await fetchWeekPage(activeContext, cursor, controller.signal);
      if (generationRef.current !== generation || controller.signal.aborted) return;
      const response = appendWeekPage(current, page, activeContext);
      setLoad({ response, loading: false, invalidating: false, error: null });
    } catch (reason) {
      if (controller.signal.aborted || generationRef.current !== generation) return;
      const code = reason instanceof WeekRequestError ? reason.code : "week-network-failed";
      if (code === "invalid-week-request" && !autoResetUsedRef.current) {
        autoResetUsedRef.current = true;
        abortRef.current?.abort();
        generationRef.current += 1;
        void runFirstPage(activeContext, generationRef.current, true);
        return;
      }
      setLoad((state) => ({ ...state, loading: false, invalidating: false, error: { code, failedCursor: cursor } }));
    }
  }, [runFirstPage]);

  const retry = useCallback(() => {
    const activeContext = contextRef.current;
    if (!activeContext) return;
    if (loadRef.current.error?.failedCursor && loadRef.current.response) void loadMore();
    else resetGeneration(activeContext);
  }, [loadMore, resetGeneration]);

  const refreshAfterAction = useCallback(() => {
    const activeContext = contextRef.current;
    if (activeContext) resetGeneration(activeContext);
  }, [resetGeneration]);

  const runAction = useCallback(async (identity: string, operation: () => Promise<unknown>) => {
    abortRef.current?.abort();
    generationRef.current += 1;
    setAction({ identity, error: null });
    try {
      await operation();
      setAction(null);
      refreshAfterAction();
    } catch (reason) {
      setAction({ identity, error: (reason as Error).message || "The action could not be completed." });
    }
  }, [refreshAfterAction]);

  if (timezone.pending) return <section className="week-view" aria-label="Week"><p role="status">Resolving Week time zone…</p></section>;
  if (!timezone.value) return (
    <section className="week-view panel" aria-label="Week time zone unavailable" role="alert">
      <code>week-timezone-unavailable</code>
      <p>{TIMEZONE_ERROR}</p>
      <button onClick={() => setTimezoneAttempt((attempt) => attempt + 1)}>Retry Week timezone</button>
    </section>
  );
  if (!context) return <section className="week-view panel" role="alert"><p>The canonical Week could not be resolved.</p></section>;

  const previous = addWeekDays(context.weekStart, -7);
  const next = addWeekDays(context.weekStart, 7);
  const todayWeek = mondayForInstant(now(), context.timezone);
  const response = load.response;
  const segments = response ? layoutWeekIntervals(response.records, context) : [];
  const actionDisabled = load.invalidating || (action !== null && action.error === null);

  return (
    <section className="week-view" data-testid="week-view" aria-label="Week">
      <div className="week-controls">
        <button disabled={!previous} onClick={() => previous && navigate(routeWithWeek(location, previous))}>Previous week</button>
        <h2>Week of <time dateTime={context.weekStart}>{context.weekStart}</time></h2>
        <button disabled={!next} onClick={() => next && navigate(routeWithWeek(location, next))}>Next week</button>
        <button disabled={!todayWeek || todayWeek === context.weekStart} onClick={() => todayWeek && navigate(routeWithWeek(location, todayWeek))}>Today</button>
      </div>
      <p className="week-zone">Calendar time zone: <strong>{context.timezone}</strong></p>

      {load.invalidating && <p role="status">The continuation expired. Discarding it and requesting this Week again…</p>}
      {load.loading && !response && !load.invalidating && <p role="status">Loading Week…</p>}
      {load.error && (() => {
        const copy = failureCopy(load.error.code);
        return <div className="panel week-error" role="alert"><h3>{copy.heading}</h3><p>{copy.detail}</p><button onClick={retry}>Retry Week page</button></div>;
      })()}

      {response && (
        <>
          <section className="week-deadline-rail" aria-label="Deadline rail">
            <h3>Deadlines</h3>
            <div className="week-seven-columns" aria-hidden="true">
              {context.dates.map((date) => <div key={date}><b>{formatWeekDay(date, context.timezone)}</b>{response.records.flatMap((record) => {
                const deadline = record.kind === "goal" ? record.deadline.date : record.kind === "task" ? record.deadline?.date : null;
                return deadline === date ? [<span key={weekIdentity(record)}>{record.title}<small>Deadline</small></span>] : [];
              })}</div>)}
            </div>
          </section>

          <section className="week-timeline" aria-label="Fixed and Tracked timeline">
            <h3>Fixed and Tracked</h3>
            <div className="week-seven-columns week-timeline-columns" aria-hidden="true">
              {context.dates.map((date, dayIndex) => <div className="week-timeline-day" key={date}><b>{formatWeekDay(date, context.timezone)}</b>{segments.filter((segment) => segment.dayIndex === dayIndex).map((segment) => (
                <span
                  key={`${segment.identity}:${segment.startsAt}`}
                  className={`week-block week-block-${segment.kind}`}
                  style={{
                    top: `${8 + segment.top * 92}%`,
                    height: `${Math.max(2.4, segment.height * 92)}%`,
                    left: `${segment.lane / segment.laneCount * 100}%`,
                    width: `${100 / segment.laneCount}%`,
                  }}
                ><b>{segment.kind === "fixed" ? "Fixed" : "Tracked"}</b> {segment.title}</span>
              ))}</div>)}
            </div>
          </section>

          <section className="week-agenda" aria-label="Week records">
            <h3>Week records</h3>
            {response.records.length === 0 ? <p>No plans, deadlines, or tracked work in this Week.</p> : (
              <ol>{response.records.map((record) => <WeekRecordCard
                key={weekIdentity(record)}
                record={record}
                context={context}
                disabled={actionDisabled}
                runTaskUpdate={(id, patch) => runAction(weekIdentity(record), () => updateTask.mutateAsync({ id, ...patch }))}
                runStart={(id) => runAction(weekIdentity(record), () => startTimer.mutateAsync(id))}
                runStop={() => runAction(weekIdentity(record), () => stopTimer.mutateAsync())}
              />)}</ol>
            )}
          </section>

          {action?.error && <div className="week-action-error" role="alert">{action.error}</div>}
          {response.nextCursor !== null && (
            <button className="week-load-more" disabled={load.loading || load.invalidating || (action !== null && action.error === null)} onClick={() => void loadMore()}>
              {load.loading ? "Loading…" : "Load more"}
            </button>
          )}
        </>
      )}
    </section>
  );
}
