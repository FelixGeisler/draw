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

  it("runs the ADR-49 production entry — there is no compiled server JS", () => {
    expect(dockerfile).toMatch(/CMD \[.*"src\/prod\.ts".*\]/);
    // The referenced entry must actually exist.
    expect(fs.existsSync(path.join(repoRoot, "server/src/prod.ts"))).toBe(true);
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
