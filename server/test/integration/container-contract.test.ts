import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Container packaging contract (#191, ADR-51). The image is infra — CI cannot
// build/run it deterministically (no guaranteed Docker/buildx), so instead of
// exercising the container this pins the WIRING the container depends on to the
// real app: if someone renames `npm start`, moves the /api/health route, or
// drops the client build step, these fail here rather than in a Pi deploy. No
// Docker required — it reads the committed files.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf-8");

const dockerfile = read("Dockerfile");
const compose = read("docker-compose.yml");
const dockerignore = read(".dockerignore");

// The exec-form CMD array the image launches, parsed from the Dockerfile — the
// same value container-runtime.test.ts spawns, so drift is caught in one place.
function dockerfileCmd(): string[] {
  const m = dockerfile.match(/^CMD\s+(\[.*\])\s*$/m);
  if (!m) throw new Error("Dockerfile has no exec-form CMD");
  return JSON.parse(m[1]) as string[];
}

describe("Dockerfile", () => {
  it("is a multi-stage build on Node 22", () => {
    // Native better-sqlite3 is compiled in a full image, shipped in a slim one.
    expect(dockerfile).toMatch(/^FROM node:22-bookworm\s+AS builder/m);
    expect(dockerfile).toMatch(/^FROM node:22-bookworm-slim\s+AS runtime/m);
  });

  it("uses a glibc runtime, not musl/alpine (better-sqlite3 has no musl prebuild)", () => {
    expect(dockerfile).toContain("bookworm-slim");
    // No FROM line may pull an alpine base (a comment mentioning it is fine).
    expect(dockerfile).not.toMatch(/^FROM\s+\S*alpine/im);
  });

  it("builds the client and prunes dev dependencies", () => {
    // client/dist is what CLIENT_DIR serves; prune keeps the image lean while
    // leaving the compiled better-sqlite3 binary in place.
    expect(dockerfile).toContain("npm run build -w client");
    expect(dockerfile).toContain("npm prune --omit=dev");
  });

  it("runs the ADR-49 entry via the tsx loader — no compiled server JS", () => {
    const cmd = dockerfileCmd();
    // `node --import tsx src/prod.ts`: both loader tokens must be present, or
    // the container would try to run TypeScript with a bare node and crash.
    expect(cmd[0]).toBe("node");
    expect(cmd).toContain("--import");
    expect(cmd).toContain("tsx");
    expect(cmd).toContain("src/prod.ts");
    // The referenced entry must actually exist.
    expect(fs.existsSync(path.join(repoRoot, "server/src/prod.ts"))).toBe(true);
  });

  it("keeps tsx a runtime dependency — the pruned image boots on it", () => {
    // `npm prune --omit=dev` runs in the builder; the container then boots via
    // `node --import tsx`, which only survives the prune if tsx is a RUNTIME
    // dependency. Demoting it to devDependencies would silently break the image
    // (nothing else here would catch it — this is that guard).
    const pkg = JSON.parse(read("server/package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.tsx).toBeDefined();
    expect(pkg.devDependencies?.tsx).toBeUndefined();
  });

  it("configures the runtime env the container relies on", () => {
    expect(dockerfile).toMatch(/CLIENT_DIR=\/app\/client\/dist/);
    expect(dockerfile).toMatch(/HOST=0\.0\.0\.0/);
    expect(dockerfile).toMatch(/DATA_DIR=\/data/);
  });

  it("puts DATA_DIR on a volume and exposes the API port", () => {
    expect(dockerfile).toMatch(/VOLUME \["\/data"\]/);
    expect(dockerfile).toMatch(/EXPOSE 3001/);
  });

  it("runs as a non-root user (acceptance criterion)", () => {
    expect(dockerfile).toMatch(/^USER node/m);
  });

  it("healthchecks the real, gate-exempt /api/health route", () => {
    const health = dockerfile.match(/HEALTHCHECK[\s\S]*?\/api\/health/);
    expect(health).not.toBeNull();
    // Anti-drift: the probed route must still be registered above the gate.
    const app = read("server/src/app.ts");
    expect(app).toContain('app.get("/api/health"');
  });
});

describe("docker-compose.yml", () => {
  it("builds the image and restarts unless stopped", () => {
    expect(compose).toMatch(/build:\s*\./);
    expect(compose).toMatch(/restart:\s*unless-stopped/);
  });

  it("persists DATA_DIR on a named volume mounted at /data", () => {
    // A named volume (not a bind) is what survives `down` + recreation.
    expect(compose).toMatch(/-\s*draw-data:\/data/);
    expect(compose).toMatch(/^volumes:/m);
    expect(compose).toMatch(/^\s{2}draw-data:/m);
  });

  it("maps the port and exposes on all interfaces", () => {
    expect(compose).toMatch(/"3001:3001"/);
    expect(compose).toMatch(/HOST:\s*"0\.0\.0\.0"/);
  });

  it("keeps DRAW_PASSWORD/TRUST_PROXY as documented LAN opt-ins", () => {
    // Present (commented) so a LAN deployer finds them; ADR-50.
    expect(compose).toMatch(/#\s*DRAW_PASSWORD:/);
    expect(compose).toMatch(/#\s*TRUST_PROXY:/);
  });

  it("documents the Tailscale recipe as a commented pair (#207, ADR-55)", () => {
    // Both halves, still commented so the LAN default is unchanged. The
    // loopback-only port is what makes trusting a hop sound; shipping the
    // TRUST_PROXY line without it would be a downgrade, not a hardening.
    expect(compose).toMatch(/#\s*-\s*"127\.0\.0\.1:3001:3001"/);
    expect(compose).toMatch(/#\s*TRUST_PROXY:\s*"1"/);
  });

  it("does not recommend the loopback preset for the container", () => {
    // A published port arrives from the Docker bridge gateway, so the peer is
    // never 127.0.0.1 and `loopback` would trust nothing — silently collapsing
    // per-IP throttling. ADR-55; this is the trap the sample must not set.
    expect(compose).not.toMatch(/TRUST_PROXY:\s*"loopback"/);
  });

  it("healthchecks /api/health", () => {
    const hc = compose.slice(compose.indexOf("healthcheck:"));
    expect(hc).toContain("/api/health");
  });
});

describe(".dockerignore", () => {
  it("keeps the host's node_modules and data out of the image context", () => {
    // A host node_modules would carry the wrong-arch better-sqlite3 binary;
    // server/data is user data that belongs on the volume, never the image.
    expect(dockerignore).toMatch(/^node_modules$/m);
    expect(dockerignore).toMatch(/^server\/data$/m);
  });
});
