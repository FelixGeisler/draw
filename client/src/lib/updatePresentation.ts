import type { BuildChannel } from "./updateNotice";

interface CurrentVersionStatus {
  current: string;
  buildChannel: BuildChannel;
  buildSha: string | null;
}

/** Formats the single Settings version value without exposing stable build identity. */
export function currentVersionLabel(status: CurrentVersionStatus): string {
  const packageVersion = `Draw ${status.current}`;
  if (status.buildSha === null) return packageVersion;
  if (status.buildChannel === "edge") {
    return `${packageVersion} · Edge ${status.buildSha.slice(0, 12)}`;
  }
  if (status.buildChannel === "local") {
    return `${packageVersion} · Local ${status.buildSha.slice(0, 12)}`;
  }
  return packageVersion;
}
