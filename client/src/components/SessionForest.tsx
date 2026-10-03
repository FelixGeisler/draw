import { useEffect, useState, type CSSProperties } from "react";
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

export interface ForestTreePlacement {
  variant: 0 | 1 | 2;
  offsetX: number;
  offsetY: number;
}

/** Presentation only: the positive safe session id is the sole input. */
export function forestTreePlacement(id: number): ForestTreePlacement {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid forest tree id");
  return {
    variant: ((id - 1) % 3) as 0 | 1 | 2,
    offsetX: (id % 17) - 8,
    offsetY: Math.floor((id - 1) / 17) % 7,
  };
}

const TRUNKS = [
  "M57 108 L59 62 L47 48 M58 73 L77 53 M56 84 L39 69",
  "M58 108 L56 65 L42 51 M57 76 L76 57 M56 88 L73 75",
  "M60 108 L61 64 L48 54 M60 75 L79 48 M59 87 L42 73",
] as const;

const BRANCHES = [
  "M47 48 L34 30 M47 48 L27 48 M77 53 L91 34 M77 53 L99 51 M39 69 L25 62 M34 30 L28 22 M91 34 L99 26 M99 51 L106 43",
  "M42 51 L29 36 M42 51 L24 54 M76 57 L91 42 M76 57 L98 60 M73 75 L91 73 M29 36 L25 27 M91 42 L99 33 M98 60 L107 55",
  "M48 54 L32 42 M48 54 L30 59 M79 48 L91 29 M79 48 L101 43 M42 73 L26 70 M32 42 L24 34 M91 29 L97 21 M101 43 L108 35",
] as const;

const LEAVES = [
  [[47, 45, 20], [70, 43, 22], [60, 27, 20], [38, 63, 15], [81, 62, 16]],
  [[40, 49, 19], [66, 48, 23], [55, 29, 19], [82, 62, 16], [49, 68, 16]],
  [[48, 52, 20], [76, 43, 21], [64, 26, 19], [35, 68, 15], [72, 68, 17]],
] as const;

function TreeArt({ living, scale, variant }: { living: boolean; scale: number; variant: 0 | 1 | 2 }) {
  return (
    <svg
      className={`forest-tree-art forest-tree-variant-${variant + 1}`}
      viewBox="0 0 120 120"
      aria-hidden="true"
      focusable="false"
    >
      <g className="forest-tree-growth" style={{ transform: `scale(${scale})` }}>
        <path className="forest-trunk" d={TRUNKS[variant]} />
        {living ? (
          <g className="forest-leaves">
            {LEAVES[variant].map(([cx, cy, r]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} />)}
          </g>
        ) : (
          <path className="forest-branches" d={BRANCHES[variant]} />
        )}
      </g>
    </svg>
  );
}

interface TreeFacts {
  id: number;
  state: "Growing" | "Living" | "Dead";
  timeLabel: "Started" | "Ended";
  timestamp: string;
  displayedTime: string;
  duration: string;
  living: boolean;
  scale: number;
}

function finishedFacts(tree: ForestTree): TreeFacts {
  const state = tree.endReason === "done" ? "Living" : "Dead";
  return {
    id: tree.id,
    state,
    timeLabel: "Ended",
    timestamp: tree.endedAt,
    displayedTime: displayTime(tree.endedAt),
    duration: formatForestDuration(Date.parse(tree.endedAt) - Date.parse(tree.startedAt)),
    living: tree.endReason === "done",
    scale: 1,
  };
}

function growingFacts(entry: CurrentTimer["entry"], now: number): TreeFacts {
  const elapsed = now - Date.parse(entry.startedAt);
  return {
    id: entry.id,
    state: "Growing",
    timeLabel: "Started",
    timestamp: entry.startedAt,
    displayedTime: displayTime(entry.startedAt),
    duration: formatForestDuration(elapsed),
    living: true,
    scale: currentTreeScale(elapsed / 60_000),
  };
}

function ForestTreeCell({
  facts,
  selected,
  onSelect,
  current,
}: {
  facts: TreeFacts;
  selected: boolean;
  onSelect: (id: number) => void;
  current: boolean;
}) {
  const placement = forestTreePlacement(facts.id);
  const style = {
    "--forest-offset-x": `${placement.offsetX}px`,
    "--forest-offset-y": `${-placement.offsetY}px`,
  } as CSSProperties;
  const accessibleName = `${facts.state}. ${facts.timeLabel} ${facts.displayedTime}. Duration ${facts.duration}.`;

  return (
    <label
      className={`forest-tree ${facts.state.toLowerCase()}`}
      data-tree-id={current ? undefined : facts.id}
      data-session-id={current ? facts.id : undefined}
      data-tree-variant={placement.variant + 1}
      style={style}
    >
      <input
        className="forest-radio"
        type="radio"
        name="forest-tree-selection"
        value={facts.id}
        aria-label={accessibleName}
        checked={selected}
        onChange={() => onSelect(facts.id)}
      />
      <span className="forest-tree-visual" aria-hidden="true">
        <TreeArt living={facts.living} scale={facts.scale} variant={placement.variant} />
        <strong className="forest-tree-state">{facts.state}</strong>
        {selected && <span className="forest-selected-mark">✓ Selected</span>}
      </span>
    </label>
  );
}

export function FinishedTree({
  tree,
  selected = false,
  onSelect = () => undefined,
}: {
  tree: ForestTree;
  selected?: boolean;
  onSelect?: (id: number) => void;
}) {
  return <ForestTreeCell facts={finishedFacts(tree)} selected={selected} onSelect={onSelect} current={false} />;
}

export function GrowingTree({
  entry,
  now,
  selected = false,
  onSelect = () => undefined,
}: {
  entry: CurrentTimer["entry"];
  now: number;
  selected?: boolean;
  onSelect?: (id: number) => void;
}) {
  return <ForestTreeCell facts={growingFacts(entry, now)} selected={selected} onSelect={onSelect} current />;
}

function selectedTreeFacts(published: PublishedForest, selectedId: number | null, now: number): TreeFacts | null {
  if (selectedId === null) return null;
  if (published.current?.entry.id === selectedId) return growingFacts(published.current.entry, now);
  const tree = published.page.trees.find((candidate) => candidate.id === selectedId);
  return tree ? finishedFacts(tree) : null;
}

export function SessionForest() {
  const { query, navigate, retry, navigationPending, navigationError } = useForest();
  const [now, setNow] = useState(Date.now());
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const data = query.data;
  const cleared = data?.kind === "cleared";
  const published: PublishedForest | null = data?.kind === "published" ? data : null;
  const windowIds = published
    ? [published.current?.entry.id, ...published.page.trees.map((tree) => tree.id)].filter((id): id is number => id != null)
    : [];
  const selectionWindow = windowIds.join(",");
  const effectiveSelectedId = selectedId !== null && windowIds.includes(selectedId)
    ? selectedId
    : windowIds[0] ?? null;

  useEffect(() => {
    if (!published?.current) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [published?.current?.entry.id]);

  useEffect(() => {
    setSelectedId((previous) => {
      if (previous !== null && windowIds.includes(previous)) return previous;
      return windowIds[0] ?? null;
    });
  }, [selectionWindow]);

  const unavailable = !published && query.isError;
  const loading = !published && !query.isError && (query.isPending || query.isFetching || cleared);
  const selectedFacts = published ? selectedTreeFacts(published, effectiveSelectedId, now) : null;

  return (
    <section className="session-forest" aria-label="Forest landscape">
      {published && (
        <div className="forest-navigation" role="group" aria-label="Forest history">
          <button
            type="button"
            disabled={navigationPending || published.requestedBeforeId === null}
            onClick={() => void navigate(null)}
          >
            Newest
          </button>
          <button
            type="button"
            disabled={navigationPending || published.page.nextBeforeId === null}
            onClick={() => published.page.nextBeforeId !== null && void navigate(published.page.nextBeforeId)}
          >
            Older
          </button>
        </div>
      )}

      {loading && <div className="forest-local-state" role="status">Loading the forest…</div>}
      {unavailable && (
        <div className="forest-local-state" role="alert">
          <p>The forest is unavailable.</p>
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
          <div className="forest-scene" aria-busy={navigationPending} data-testid="forest-scene">
            <fieldset className="forest-world">
              <legend className="forest-legend">Forest trees</legend>
              {published.current && (
                <GrowingTree
                  entry={published.current.entry}
                  now={now}
                  selected={effectiveSelectedId === published.current.entry.id}
                  onSelect={setSelectedId}
                />
              )}
              {published.page.trees.map((tree) => (
                <FinishedTree
                  key={tree.id}
                  tree={tree}
                  selected={effectiveSelectedId === tree.id}
                  onSelect={setSelectedId}
                />
              ))}
              {windowIds.length === 0 && (
                <p className="forest-empty">Start a working session to grow the first tree.</p>
              )}
            </fieldset>
          </div>
          {selectedFacts && (
            <section className="forest-details" aria-label="Selected tree details">
              <dl>
                <div><dt>State</dt><dd>{selectedFacts.state}</dd></div>
                <div>
                  <dt>{selectedFacts.timeLabel}</dt>
                  <dd><time dateTime={selectedFacts.timestamp}>{selectedFacts.displayedTime}</time></dd>
                </div>
                <div><dt>Duration</dt><dd>{selectedFacts.duration}</dd></div>
              </dl>
            </section>
          )}
        </>
      )}
    </section>
  );
}
