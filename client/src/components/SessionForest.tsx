import { useEffect, useState } from "react";
import { useForest } from "../hooks/useForest";
import {
  currentTreeScale,
  type CurrentTimer,
  type ForestTree,
  type PublishedForest,
} from "../lib/forest";
import "./SessionForest.css";

export function formatForestDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function displayTime(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function TreeArt({ living, scale = 1 }: { living: boolean; scale?: number }) {
  return (
    <svg className="forest-tree-art" viewBox="0 0 120 120" aria-hidden="true" focusable="false">
      <g className="forest-tree-growth" style={{ transform: `scale(${scale})` }}>
        <path className="forest-trunk" d="M55 104 L58 61 L48 48 M59 70 L76 52 M57 80 L41 68" />
        {living ? (
          <g className="forest-leaves">
            <circle cx="48" cy="45" r="20" />
            <circle cx="70" cy="43" r="22" />
            <circle cx="60" cy="28" r="20" />
            <circle cx="39" cy="62" r="15" />
            <circle cx="80" cy="61" r="16" />
          </g>
        ) : (
          <g className="forest-branches">
            <path d="M48 48 L35 31 M48 48 L28 48 M76 52 L91 34 M76 52 L98 51 M41 68 L27 62" />
            <path d="M35 31 L29 23 M91 34 L98 26 M98 51 L105 44" />
          </g>
        )}
        <path className="forest-ground" d="M31 105 Q60 98 89 105" />
      </g>
    </svg>
  );
}

export function ForestTreeCard({ tree }: { tree: ForestTree }) {
  const start = Date.parse(tree.startedAt);
  const end = Date.parse(tree.endedAt);
  const living = tree.endReason === "done";
  const state = living ? "Living" : "Dead";
  const duration = formatForestDuration(end - start);
  const ended = displayTime(tree.endedAt);
  return (
    <article data-tree-id={tree.id} className={`forest-tree ${living ? "living" : "dead"}`} aria-label={`${state} tree. Ended ${ended}. Duration ${duration}.`}>
      <TreeArt living={living} />
      <strong>{state}</strong>
      <span>Ended <time dateTime={tree.endedAt}>{ended}</time></span>
      <span>{duration}</span>
    </article>
  );
}

export function GrowingTreeCard({ timer, now }: { timer: CurrentTimer; now: number }) {
  const start = Date.parse(timer.entry.startedAt);
  const duration = formatForestDuration(now - start);
  const started = displayTime(timer.entry.startedAt);
  const scale = currentTreeScale((now - start) / 60_000);
  return (
    <article data-session-id={timer.entry.id} className="forest-tree growing" aria-label={`Growing tree. Started ${started}. Duration ${duration}.`}>
      <TreeArt living scale={scale} />
      <strong>Growing</strong>
      <span>Started <time dateTime={timer.entry.startedAt}>{started}</time></span>
      <span>{duration}</span>
    </article>
  );
}

export function SessionForest() {
  const { query, navigate, retry, navigationPending, navigationError } = useForest();
  const [now, setNow] = useState(Date.now());
  const data = query.data;
  const cleared = data?.kind === "cleared";
  const published: PublishedForest | null = data?.kind === "published" ? data : null;

  useEffect(() => {
    if (!published?.current) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [published?.current?.entry.id]);

  const unavailable = !published && query.isError;
  const loading = !published && !query.isError && (query.isPending || query.isFetching || cleared);

  return (
    <section className="session-forest" aria-labelledby="session-forest-title">
      <div className="forest-heading">
        <div>
          <h2 id="session-forest-title">Session forest</h2>
          <p>Every finished working session leaves its own tree.</p>
        </div>
        {published && (
          <div className="forest-navigation" aria-label="Forest history pages">
            {published.requestedBeforeId !== null && (
              <button type="button" disabled={navigationPending} onClick={() => void navigate(null)}>Newest</button>
            )}
            <button
              type="button"
              disabled={navigationPending || published.page.nextBeforeId === null}
              onClick={() => published.page.nextBeforeId !== null && void navigate(published.page.nextBeforeId)}
            >
              Older
            </button>
          </div>
        )}
      </div>

      {loading && <div className="panel forest-message" role="status">Loading the forest…</div>}
      {unavailable && (
        <div className="panel forest-message" role="alert">
          <p>The forest is unavailable. Other Stats views are still available.</p>
          <button type="button" onClick={() => void query.refetch()}>Retry</button>
        </div>
      )}

      {published && (
        <>
          {(navigationError || query.error) && (
            <div className="forest-inline-error" role="alert">
              <span>{navigationError ?? "The forest could not be refreshed."}</span>
              <button type="button" onClick={() => void (navigationError ? retry() : navigate(null))}>Retry</button>
            </div>
          )}
          <div className="forest-grid" aria-busy={navigationPending}>
            {published.current && <GrowingTreeCard timer={published.current} now={now} />}
            {published.page.trees.map((tree) => <ForestTreeCard key={tree.id} tree={tree} />)}
          </div>
          {!published.current && published.page.trees.length === 0 && (
            <div className="panel forest-message">Start a working session to grow the first tree.</div>
          )}
        </>
      )}
    </section>
  );
}
