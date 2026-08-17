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

// BACKUP_INTERVAL_HOURS (#194, ADR-52): the period between automatic backups.
// Unset, 0, non-numeric, or non-positive = disabled — the production entry
// starts no timer, so behavior is identical to before (local dev stays silent
// unless deliberately configured). A positive value (fractional allowed) is
// the interval in hours; the scheduler writes one archive into
// DATA_DIR/backups/ each tick. Only the production entry consumes it — dev is
// a developer's machine, restarted constantly, not the headless Pi this exists
// for (ADR-52), the same prod-entry-only stance HOST and DRAW_PASSWORD take.
//
// Capped at MAX_BACKUP_INTERVAL_HOURS: setInterval's delay is a signed 32-bit
// int of milliseconds, so anything over 2147483647ms (~24.85 days) silently
// WRAPS to a 1ms delay — a runaway backup loop pegging the Pi (e.g. a
// well-meaning BACKUP_INTERVAL_HOURS=720 for "monthly"). An over-large value is
// clamped to the cap, not rejected, and the clamp is logged to stderr.
export const MAX_BACKUP_INTERVAL_HOURS = Math.floor(2_147_483_647 / (60 * 60 * 1000)); // 596
export function resolveBackupIntervalHours(env: NodeJS.ProcessEnv = process.env): number {
  const hours = Number(env.BACKUP_INTERVAL_HOURS);
  if (!(Number.isFinite(hours) && hours > 0)) return 0;
  if (hours > MAX_BACKUP_INTERVAL_HOURS) {
    console.error(
      `[server] BACKUP_INTERVAL_HOURS=${hours} exceeds the ${MAX_BACKUP_INTERVAL_HOURS}h maximum ` +
        `(setInterval overflows past that) — clamping to ${MAX_BACKUP_INTERVAL_HOURS}h`,
    );
    return MAX_BACKUP_INTERVAL_HOURS;
  }
  return hours;
}

// BACKUP_RETENTION (#194, ADR-52): how many scheduled archives under
// DATA_DIR/backups/ to keep — older ones are pruned after each run. Defaults
// to 7. A blank, non-integer, zero, negative, or otherwise out-of-range value
// falls back to the default (7) rather than failing the boot — in particular 0
// is NOT honored, since keeping zero archives would delete the one the run just
// wrote.
export const DEFAULT_BACKUP_RETENTION = 7;
export function resolveBackupRetention(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.BACKUP_RETENTION?.trim();
  if (!raw) return DEFAULT_BACKUP_RETENTION;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_BACKUP_RETENTION;
}

// UPDATE_CHECK_INTERVAL_HOURS (#247): the period between release checks.
// Unlike BACKUP_INTERVAL_HOURS this knob is default-ON: unset/blank resolves
// to 24 (the daily release check), because the check is the product default
// and only an explicit 0 (or a negative) turns it off — 0 means zero timers
// and zero outbound calls, the #235 rule. Garbage falls back to the DEFAULT,
// not to disabled: an unparseable value silently switching a default-on
// feature off would be a setting that lies. Same int32 setInterval clamp as
// backups (MAX_BACKUP_INTERVAL_HOURS, logged to stderr). Prod-entry-only,
// like every knob of this class — createApp()/dev never start the timer.
export const DEFAULT_UPDATE_CHECK_INTERVAL_HOURS = 24;
export function resolveUpdateCheckIntervalHours(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.UPDATE_CHECK_INTERVAL_HOURS?.trim();
  if (!raw) return DEFAULT_UPDATE_CHECK_INTERVAL_HOURS;
  const hours = Number(raw);
  if (!Number.isFinite(hours)) return DEFAULT_UPDATE_CHECK_INTERVAL_HOURS;
  if (hours <= 0) return 0; // an explicit off-switch, unlike garbage above
  if (hours > MAX_BACKUP_INTERVAL_HOURS) {
    console.error(
      `[server] UPDATE_CHECK_INTERVAL_HOURS=${hours} exceeds the ${MAX_BACKUP_INTERVAL_HOURS}h maximum ` +
        `(setInterval overflows past that) — clamping to ${MAX_BACKUP_INTERVAL_HOURS}h`,
    );
    return MAX_BACKUP_INTERVAL_HOURS;
  }
  return hours;
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
