import { createHash, createHmac, scryptSync, timingSafeEqual } from "node:crypto";
import type { RequestHandler, Response } from "express";
import { renderLoginPage } from "./loginPage.js";

// Optional LAN password gate (#190, ADR-50). One shared secret from the
// DRAW_PASSWORD env var — no user accounts, no session store, no new
// dependencies: sessions are stateless HMAC-signed expiry tokens
// (node:crypto), so the only server-side state is the login rate limiter.

export const SESSION_COOKIE = "draw_session";
// Session lifetime — documented in ADR-50 and README. The cookie's Max-Age
// matches the token's embedded expiry; after 30 days the next request lands
// on the login page again.
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Header credential for non-browser clients (the MCP adapter, scripts):
// accepted everywhere the session cookie is, carrying the shared secret.
export const PASSWORD_HEADER = "x-draw-password";

/**
 * Constant-time string comparison. Hashing both sides first gives
 * timingSafeEqual equal-length inputs, so neither length nor the position of
 * the first differing byte leaks through response timing.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Session-signing key, derived deterministically from the password (scrypt,
 * fixed salt): sessions survive server restarts, changing DRAW_PASSWORD
 * revokes every outstanding cookie, and forging a token requires the
 * password itself — which already IS the credential, so no second secret
 * needs managing.
 */
export function deriveSessionKey(password: string): Buffer {
  return scryptSync(password, "draw-session-v1", 32);
}

export function signSession(key: Buffer, expiresAtMs: number): string {
  const payload = String(expiresAtMs);
  const signature = createHmac("sha256", key).update(payload).digest("hex");
  return `${payload}.${signature}`;
}

export function verifySession(key: Buffer, token: string, nowMs = Date.now()): boolean {
  const dot = token.indexOf(".");
  if (dot === -1) return false;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expiresAtMs = Number(payload);
  if (!Number.isFinite(expiresAtMs)) return false;
  const expected = createHmac("sha256", key).update(payload).digest("hex");
  // Signature before expiry: an attacker must not learn anything from a
  // forged-but-expired token, and the comparison itself is constant-time.
  if (!timingSafeEqualStrings(signature, expected)) return false;
  return expiresAtMs > nowMs;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** When blocked: how long until the window frees up again. */
  retryAfterMs: number;
}

/**
 * Per-IP fixed window over FAILED password presentations only (login body or
 * shared-secret header). Requests with no credential — or with an expired /
 * tampered cookie, which is aging, not attacking — never count. In-memory by
 * design: a restart clears it, and restarting is an owner action.
 */
export class LoginRateLimiter {
  private readonly failures = new Map<string, { count: number; windowStartMs: number }>();

  constructor(
    private readonly maxAttempts = 5,
    private readonly windowMs = 15 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  check(ip: string): RateLimitDecision {
    const entry = this.failures.get(ip);
    if (!entry) return { allowed: true, retryAfterMs: 0 };
    const elapsed = this.now() - entry.windowStartMs;
    if (elapsed >= this.windowMs) {
      this.failures.delete(ip);
      return { allowed: true, retryAfterMs: 0 };
    }
    if (entry.count >= this.maxAttempts) {
      return { allowed: false, retryAfterMs: this.windowMs - elapsed };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  recordFailure(ip: string): void {
    const nowMs = this.now();
    const entry = this.failures.get(ip);
    if (!entry || nowMs - entry.windowStartMs >= this.windowMs) {
      this.failures.set(ip, { count: 1, windowStartMs: nowMs });
    } else {
      entry.count += 1;
    }
  }

  recordSuccess(ip: string): void {
    this.failures.delete(ip);
  }
}

/**
 * Is this the loopback host? The effective client address is `req.ip`, which
 * Express de-proxies when `trust proxy` is configured (ADR-50): a same-host
 * MCP adapter or the in-process assistant connects over 127.0.0.1 with no
 * `X-Forwarded-For`, so it stays loopback, while a LAN client arriving
 * through a same-host reverse proxy resolves to its real forwarded address.
 * The whole 127.0.0.0/8 block and IPv6 `::1` (incl. the IPv4-mapped form).
 */
export function isLoopbackAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  const normalized = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  return normalized === "::1" || /^127\./.test(normalized);
}

/** Minimal cookie-header parse — one cookie of our own making, no dependency. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return cookies;
}

export interface AuthHandlers {
  /** POST /api/auth/login — mounted BEFORE the gate so it stays reachable. */
  loginHandler: RequestHandler;
  /** Blanket middleware behind /api/health and the login route. */
  gate: RequestHandler;
}

export interface CreateAuthOptions {
  limiter?: LoginRateLimiter;
  /**
   * Password comparator, injectable so a test can prove the login and header
   * checks route through the constant-time path (a regression to `===` fails
   * that test). Defaults to the timing-safe compare — production never passes
   * anything else.
   */
  compare?: (a: string, b: string) => boolean;
}

export function createAuth(password: string, options: CreateAuthOptions = {}): AuthHandlers {
  const limiter = options.limiter ?? new LoginRateLimiter();
  const compare = options.compare ?? timingSafeEqualStrings;
  const key = deriveSessionKey(password);

  const rejectLimited = (res: Response, retryAfterMs: number) => {
    res
      .status(429)
      .set("Retry-After", String(Math.ceil(retryAfterMs / 1000)))
      .json({ error: "too many failed attempts — try again later" });
  };

  const issueSession = (res: Response) => {
    res.cookie(SESSION_COOKIE, signSession(key, Date.now() + SESSION_TTL_MS), {
      httpOnly: true,
      sameSite: "lax",
      maxAge: SESSION_TTL_MS,
      path: "/",
      // No `secure` flag: the LAN deployment is plain HTTP by design —
      // TLS is a reverse proxy's job (ADR-50 threat model).
    });
    res.status(204).end();
  };

  const loginHandler: RequestHandler = (req, res) => {
    // The login FORM is always throttled, loopback included: no trusted client
    // ever POSTs here (the in-process assistant and MCP use the header path),
    // so a loopback exemption would have no legitimate user — it would only
    // open unlimited brute-force against the shared password whenever req.ip
    // collapses to loopback (a same-host proxy with TRUST_PROXY unset). A
    // human logging in on the host getting 5/15min is a fine price (ADR-50).
    const ip = req.ip ?? "unknown";
    const decision = limiter.check(ip);
    if (!decision.allowed) {
      rejectLimited(res, decision.retryAfterMs);
      return;
    }
    const submitted = (req.body as { password?: unknown } | undefined)?.password;
    if (typeof submitted === "string" && compare(submitted, password)) {
      limiter.recordSuccess(ip);
      issueSession(res);
      return;
    }
    limiter.recordFailure(ip);
    res.status(401).json({ error: "invalid password" });
  };

  const gate: RequestHandler = (req, res, next) => {
    const trusted = isLoopbackAddress(req.ip);
    const ip = req.ip ?? "unknown";

    // Shared-secret header first (MCP, scripts, the in-process assistant).
    const headerSecret = req.get(PASSWORD_HEADER);
    if (headerSecret !== undefined) {
      // Loopback header clients present the real secret from inside the trust
      // boundary: they must neither trip nor RESET the brute-force counter
      // (an in-process self-request must not wipe an attacker's tally — the
      // #190 review's finding B). Non-loopback header presentations are a LAN
      // brute-force channel and are throttled exactly like the login form.
      if (trusted) {
        if (compare(headerSecret, password)) {
          next();
          return;
        }
        res.status(401).json({ error: "invalid password" });
        return;
      }
      const decision = limiter.check(ip);
      if (!decision.allowed) {
        rejectLimited(res, decision.retryAfterMs);
        return;
      }
      if (compare(headerSecret, password)) {
        limiter.recordSuccess(ip);
        next();
        return;
      }
      limiter.recordFailure(ip);
      res.status(401).json({ error: "invalid password" });
      return;
    }

    // A present-but-invalid or expired cookie is aging, not attacking: it is
    // deliberately NOT counted against the limiter (only the header path
    // records), so an owner whose cookie lapsed can never be locked out.
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token && verifySession(key, token)) {
      next();
      return;
    }

    // No valid credential. The API namespace answers JSON (matching the
    // case-insensitive /api mounts); a browser page view gets the login
    // page — with a 401 status, so nothing unauthenticated ever reads as OK.
    if (/^\/api(\/|$)/i.test(req.path)) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      res.status(401).type("html").send(renderLoginPage());
      return;
    }
    res.status(401).json({ error: "authentication required" });
  };

  return { loginHandler, gate };
}
