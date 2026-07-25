// Listener address resolution, in its own dependency-free module so unit
// tests can cover it without pulling the app (and its database) in.

// Loopback by default: single local user by design (arc42 8.5), so a stock
// install is not reachable from the LAN. listen(port) without a host would
// bind all interfaces unconditionally, which is why the default is spelled
// out here.
export const DEFAULT_HOST = "127.0.0.1";

// Deliberately consumed ONLY by the production entry (prod.ts): HOST is the
// explicit opt-in to LAN exposure for the self-hosted deployment (#189,
// ADR-49) — e.g. HOST=0.0.0.0 in a container. `npm run dev` stays pinned to
// loopback no matter what a shell profile or devcontainer exports — the same
// ambient-injection class API_PORT-not-PORT guards against below.
export function resolveHost(env: NodeJS.ProcessEnv = process.env): string {
  const host = env.HOST?.trim();
  return host || DEFAULT_HOST;
}

// API_PORT, never PORT: dev tooling injects PORT (see server/.env.example),
// so honoring it would rebind the API whenever some tool exports it.
export function resolveApiPort(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.API_PORT) || 3001;
}

// DRAW_PASSWORD (#190, ADR-50): the shared secret that switches the LAN
// password gate on. Unset or blank = no auth, behavior identical to before.
// Like HOST, only the production entry consumes it — `npm run dev` serves
// the client through Vite, which the gate could never cover, so an ambient
// export must not half-lock the dev API. The MCP adapter reads it too, to
// authenticate against a protected instance.
export function resolvePassword(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const password = env.DRAW_PASSWORD?.trim();
  return password || undefined;
}
