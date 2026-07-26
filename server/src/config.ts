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

// TRUST_PROXY (#190, ADR-50): what Express's `trust proxy` setting should be,
// which is what makes `req.ip` the DE-PROXIED client address behind a reverse
// proxy — the address the login rate limiter keys on. Off by default (direct
// binding trusts nobody). Behind a same-host TLS proxy, leaving this unset
// makes every request look like it came from the proxy (loopback), collapsing
// per-IP throttling — hence the knob. Accepts the shapes Express does:
//   - "true"/"false"  → boolean
//   - a whole number  → trusted hop count (e.g. "1" for one proxy)
//   - anything else    → passed through: a subnet/CSV list or a preset name
//                        like "loopback" (the recommended same-host setting).
// Prefer "loopback" or a hop count over "true": trusting every hop lets a LAN
// client spoof X-Forwarded-For to forge its address.
export function resolveTrustProxy(
  env: NodeJS.ProcessEnv = process.env,
): boolean | number | string {
  const raw = env.TRUST_PROXY?.trim();
  if (!raw) return false;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

// Loopback hosts are unreachable from the LAN, so exposing them needs no
// password. Everything else — 0.0.0.0, `::`, a specific LAN IP — is reachable.
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "localhost" || h === "::1" || /^127\./.test(h);
}

// LAN-exposure guardrail (#191, ADR-51): binding a non-loopback host with no
// DRAW_PASSWORD (#190, ADR-50) puts the task history AND the Anthropic API key
// on the network unprotected. The production entry prints this to stderr at
// boot; the decision is a pure function so it is unit-testable without binding
// a socket. HOST is a deliberate opt-in, so this warns — it does not refuse.
export function lanExposureWarning(
  host: string,
  password: string | undefined,
): string | undefined {
  if (password) return undefined;
  if (isLoopbackHost(host)) return undefined;
  return `[server] WARNING: bound to ${host} with no DRAW_PASSWORD — anyone on your network can access this instance (ADR-50)`;
}
