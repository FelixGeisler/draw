// Listener address resolution, in its own dependency-free module so unit
// tests can cover it without pulling the app (and its database) in.

// Loopback by default: single local user by design (arc42 8.5), so a stock
// install is not reachable from the LAN. HOST is the deliberate opt-in for
// the self-hosted deployment (#189, ADR-49) — e.g. HOST=0.0.0.0 in a
// container. listen(port) without a host would bind all interfaces
// unconditionally, which is why the default is spelled out here.
export const DEFAULT_HOST = "127.0.0.1";

export function resolveHost(env: NodeJS.ProcessEnv = process.env): string {
  const host = env.HOST?.trim();
  return host || DEFAULT_HOST;
}

// API_PORT, never PORT: dev tooling injects PORT (see server/.env.example),
// so honoring it would rebind the API whenever some tool exports it.
export function resolveApiPort(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.API_PORT) || 3001;
}
