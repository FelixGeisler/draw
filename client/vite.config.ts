import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// VITE_PORT / API_PORT allow E2E tests to run on separate ports
// next to a live dev server.
// 127.0.0.1 (not localhost): the API binds loopback IPv4 only, and
// localhost may resolve to ::1 first.
const apiOrigin = `http://127.0.0.1:${process.env.API_PORT || 3001}`;

/**
 * Hold `/api` requests until the API answers, once, at dev start (#103).
 *
 * Vite serves in well under a second while the server is still opening the
 * database, running migrations and settling the WAL — several seconds on a
 * cold start. Every `/api` call the browser makes in that window hits a
 * refused connection, and Vite's proxy prints a full ECONNREFUSED stack for
 * each one: a wall of red for a condition that resolves itself, which reads
 * exactly like a crash. (Everything works: the client's queries retry.)
 *
 * The noise cannot be filtered downstream — Vite registers its own proxy
 * error handler AFTER this plugin's `configure` hook and logs unconditionally
 * — so the requests must not reach the proxy at all until there is something
 * to proxy to. `configureServer` middlewares run before Vite's internal
 * proxy, which makes this gate the one place that can hold them. One info
 * line, then silence, then a normal startup.
 *
 * `ready` latches on purpose: this gate exists for the boot window only. An
 * API that dies mid-session must still surface as the proxy's ordinary error
 * rather than as a silently hanging request, and so must an API that never
 * comes up at all — hence the deadline, after which the gate steps aside and
 * lets the real error through.
 */
function apiBootGate(): Plugin {
  let ready = false;
  let gate: Promise<void> | null = null;

  async function waitForApi(): Promise<void> {
    console.log(`  ➜  API:     waiting for ${apiOrigin} to finish booting…`);
    const deadline = Date.now() + 30_000;
    let answered = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${apiOrigin}/api/health`, { signal: AbortSignal.timeout(1_000) });
        if (res.ok) {
          answered = true;
          break;
        }
      } catch {
        // Still booting — the entire point of the gate.
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    // The deadline expiring is a different fact from the gate opening (#130):
    // without this line a dead boot reads as a normal one — "waiting for … to
    // finish booting…" and then half a minute of silence — where it used to
    // fail instantly and loudly. Announce the OUTCOME, not the clock: a check
    // that started before the deadline and resolved ok just after it is a
    // successful boot, not a failure.
    if (!answered) {
      console.log(
        `  ➜  API:     ${apiOrigin} did not answer in 30s — letting the proxy error through`,
      );
    }
    ready = true;
  }

  return {
    name: "draw:api-boot-gate",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (ready || !req.url?.startsWith("/api")) return next();
        gate ??= waitForApi();
        void gate.then(() => next());
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), apiBootGate()],
  server: {
    port: Number(process.env.VITE_PORT) || 5173,
    strictPort: true,
    proxy: {
      "/api": apiOrigin,
    },
  },
});
