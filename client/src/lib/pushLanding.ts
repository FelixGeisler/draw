export interface LandingLocation {
  pathname: string;
  search: string;
  hash: string;
  state: unknown;
}

export interface LandingResult {
  destination: string;
  state: unknown;
  focusId: number | null;
  showDone: boolean;
  hadUrlFocus: boolean;
  consumed: boolean;
}

interface RawEntry {
  raw: string;
  rawKey: string;
  rawValue: string;
  key: string | null;
  value: string | null;
}

function decode(value: string): string | null {
  try { return decodeURIComponent(value.replace(/\+/g, " ")); } catch { return null; }
}

function entries(search: string): RawEntry[] {
  if (!search.startsWith("?") || search.length === 1) return [];
  return search.slice(1).split("&").map((raw) => {
    const separator = raw.indexOf("=");
    const rawKey = separator < 0 ? raw : raw.slice(0, separator);
    const rawValue = separator < 0 ? "" : raw.slice(separator + 1);
    return { raw, rawKey, rawValue, key: decode(rawKey), value: decode(rawValue) };
  });
}

export function canonicalPositiveInteger(value: unknown): number | null {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && String(number) === value ? number : null;
}

function stateRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function withoutOwnedState(state: unknown, keys: readonly string[]): unknown {
  const record = stateRecord(state);
  if (!record) return state;
  const next = { ...record };
  for (const key of keys) delete next[key];
  return Object.keys(next).length === 0 ? null : next;
}

/**
 * Consumes the Push-owned URL/state fields without normalising unrelated query
 * bytes. Encoded keys are owned and removed, but never qualify as canonical.
 */
export function consumePushLanding(location: LandingLocation, kind: "task" | "goal"): LandingResult {
  const parsed = entries(location.search);
  const ownedKeys = kind === "task" ? new Set(["focus", "showDone"]) : new Set(["focus"]);
  const focus = parsed.filter((entry) => entry.key === "focus");
  const showDone = kind === "task" ? parsed.filter((entry) => entry.key === "showDone") : [];
  const hadUrlFocus = focus.length > 0;
  const canonicalFocus = focus.length === 1 && focus[0].rawKey === "focus" &&
    focus[0].rawValue === focus[0].value
    ? canonicalPositiveInteger(focus[0].value)
    : null;
  const canonicalShowDone = kind === "task" && canonicalFocus !== null && showDone.length === 1 &&
    showDone[0].rawKey === "showDone" && showDone[0].rawValue === "1" && showDone[0].value === "1";
  const kept = parsed.filter((entry) => !entry.key || !ownedKeys.has(entry.key)).map((entry) => entry.raw);
  const nextSearch = kept.length > 0 ? `?${kept.join("&")}` : "";
  const stateKeys = kind === "task" ? ["focusTaskId", "showDone"] : ["focusGoalId"];
  const state = stateRecord(location.state);
  const paletteId = kind === "task" ? state?.focusTaskId : state?.focusGoalId;
  const paletteFocus = typeof paletteId === "number" && Number.isSafeInteger(paletteId) && paletteId > 0
    ? paletteId
    : null;
  const paletteShowDone = kind === "task" && state?.showDone === true;
  const focusId = hadUrlFocus ? canonicalFocus : paletteFocus;
  return {
    destination: `${location.pathname}${nextSearch}${location.hash}`,
    state: withoutOwnedState(location.state, stateKeys),
    focusId,
    showDone: hadUrlFocus ? canonicalShowDone : paletteShowDone,
    hadUrlFocus,
    consumed: parsed.some((entry) => entry.key !== null && ownedKeys.has(entry.key)) ||
      stateKeys.some((key) => state !== null && Object.prototype.hasOwnProperty.call(state, key)),
  };
}
