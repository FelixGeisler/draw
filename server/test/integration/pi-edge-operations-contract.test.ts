import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Static operations contract for #286 / ADR-70. These files are deployed and
// executed by an operator, not by application code, so the focused test pins
// the exact opt-in boundary and fail-closed runbook without touching Docker,
// GHCR, GitHub settings, or the Pi.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const read = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

const adr = read("docs/modules/ROOT/pages/09_architecture_decisions.adoc");
const runbook = read("docs/modules/ROOT/pages/07_deployment_view.adoc");
const edgeCompose = read("docker-compose.pi-edge.yml");
const baseCompose = read("docker-compose.yml");
const contributing = read("CONTRIBUTING.md");
const compact = (source: string) =>
  source.replace(/\s+#\s+/g, " ").replace(/\s+/g, " ").trim();
const expectText = (source: string, required: string) =>
  expect(compact(source)).toContain(compact(required));

const WATCHTOWER_DIGEST =
  "sha256:6dd50763bbd632a83cb154d5451700530d1e44200b268a4e9488fefdfcf2b038";
const WATCHTOWER_REF = `containrrr/watchtower:1.7.1@${WATCHTOWER_DIGEST}`;
const ARM64_CHILD =
  "sha256:f14f090fcc8235449da45ccbb1aea3b424ed3b101bcbd3de56526909397c2369";
const LIST_MEDIA_TYPE =
  "application/vnd.docker.distribution.manifest.list.v2+json";

function expectBoundary(source: string) {
  const text = compact(source);
  expect(text).toMatch(/explicit(?:ly)?[- ]opt(?:s|-)in/i);
  expect(text).toMatch(/operational `?edge`? channel/i);
  expect(text).toMatch(/Draw (?:still )?(?:has|performs) no scheduled apply/i);
  expect(text).toMatch(/never receives? `?docker\.sock`?/i);
  expect(text).toMatch(/manual (?:HTTP-)?API\/trigger boundar(?:y|ies)/i);
  expect(text).toMatch(/base[,/]|base\/stable\/local|base, stable, and local/i);
  expect(text).toMatch(/polling-off/i);
  expect(text).toMatch(/non-edge/i);
  expect(text).toMatch(/not (?:GitHub )?Release discovery/i);
}

describe("Pi edge opt-in boundary", () => {
  it("records the same narrow ADR-70 boundary in ADR, runbook, and config", () => {
    expectBoundary(adr);
    expectBoundary(runbook);
    expectBoundary(edgeCompose);

    for (const source of [adr, runbook, edgeCompose]) {
      for (const governingAdr of ["ADR-26", "ADR-51", "ADR-52", "ADR-55"]) {
        expect(source).toContain(governingAdr);
      }
    }

    for (const source of [adr, runbook, edgeCompose, baseCompose, contributing]) {
      expect(source).not.toMatch(/automatic updates? (?:are|is) enabled by default/i);
      expect(source).not.toMatch(/all deployments? (?:automatically|auto-)/i);
    }
  });

  it("leaves the ordinary Compose sample polling-off and non-edge", () => {
    expect(baseCompose).toContain("deliberately has no Watchtower service");
    expect(baseCompose).toContain("does not use");
    expect(baseCompose).not.toMatch(/^\s+watchtower:\s*$/m);
    expect(baseCompose).not.toContain("ghcr.io/felixgeisler/draw:edge");
    expect(baseCompose).not.toContain("WATCHTOWER_HTTP_API_PERIODIC_POLLS");
  });
});

describe("committed opt-in Compose contract", () => {
  it("resolves the approved edge selections and scopes Watchtower to Draw", () => {
    expect(edgeCompose).toContain("DRAW_TAG=edge");
    expect(edgeCompose).toContain("AUTO_UPDATE=true");
    expect(edgeCompose).toContain("AUTO_UPDATE_INTERVAL_SECONDS=300");
    expect(edgeCompose).toContain(
      "image: ghcr.io/felixgeisler/draw:${DRAW_TAG:-edge}",
    );
    expect(edgeCompose).toContain(`image: ${WATCHTOWER_REF}`);
    expect(edgeCompose).not.toMatch(/^\s+build:/m);

    expect(edgeCompose.match(/com\.centurylinklabs\.watchtower\.enable=true/g)).toHaveLength(1);
    const watchtowerService = edgeCompose.slice(edgeCompose.indexOf("\n  watchtower:"));
    expect(watchtowerService).not.toContain(
      "com.centurylinklabs.watchtower.enable=true",
    );

    const exactEnvironment = [
      'DOCKER_API_VERSION: "1.43"',
      'WATCHTOWER_HTTP_API_UPDATE: "true"',
      'WATCHTOWER_HTTP_API_TOKEN: "${WATCHTOWER_TOKEN}"',
      'WATCHTOWER_LABEL_ENABLE: "true"',
      'WATCHTOWER_CLEANUP: "true"',
      'WATCHTOWER_HTTP_API_PERIODIC_POLLS: "${AUTO_UPDATE:-true}"',
      'WATCHTOWER_POLL_INTERVAL: "${AUTO_UPDATE_INTERVAL_SECONDS:-300}"',
      'TRUST_PROXY: "1"',
      'BACKUP_INTERVAL_HOURS: "${BACKUP_INTERVAL_HOURS:-24}"',
      'BACKUP_RETENTION: "${BACKUP_RETENTION:-7}"',
      'TZ: "${TZ:-Europe/Berlin}"',
      '127.0.0.1:3001:3001',
      'draw-data:/data',
    ];
    for (const value of exactEnvironment) expect(edgeCompose).toContain(value);
  });

  it("pins the registry manifest list and documents the socket boundary", () => {
    expect(edgeCompose).toContain(WATCHTOWER_REF);
    expect(edgeCompose).toContain(
      "Verified top-level registry manifest-list digest, not a local image ID.",
    );
    expect(edgeCompose).toContain("Root-equivalent host control");
    expect(edgeCompose).toContain("Draw never receives this socket");
    expect(edgeCompose).toContain("Changing this reviewed tag-and-digest reference requires a new review");
    expectText(runbook, "Polling may replace Draw without another prompt");
    expectText(runbook, "cleanup removes superseded local images, not GHCR immutable tags");
    expectText(runbook, "There is no automatic rollback and no automatic backup restoration");
  });
});

describe("registry and credential gates", () => {
  it("keeps anonymous GHCR active and defines only the approved private fallback", () => {
    expectText(runbook, "Public, anonymous GHCR access is the active policy");
    expectText(runbook, "configure no registry credential while that succeeds");
    expectText(runbook, "one dedicated package-read credential");
    expectText(runbook, "no package write/delete scope");
    expectText(runbook, "/home/raspberry/draw/watchtower-docker-config");
    expectText(runbook, "mode `0700`");
    expectText(runbook, "`config.json` has mode `0600`");
    expectText(runbook, "mounted read-only as `/config.json`");
    expectText(runbook, "host-default Docker login/config");
    expectText(runbook, "Failed initial or rotated access stops Watchtower");
    expect(edgeCompose).toMatch(
      /^\s*# - \/home\/raspberry\/draw\/watchtower-docker-config\/config\.json:\/config\.json:ro$/m,
    );
  });

  it("forbids secret material and assigns fallback lifecycle ownership", () => {
    expectText(runbook, "coordinator owns initial provisioning");
    expectText(runbook, "designated Pi deployment operator owns rotation");
    expectText(runbook, "Never put a token, password, Docker auth/config content");
    expectText(contributing, "rendered secret configuration");
    expect(edgeCompose).toContain('${WATCHTOWER_TOKEN}');
    expect(edgeCompose).not.toMatch(/ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+/);
  });
});

describe("backup, activation, and rollback safety", () => {
  it("requires a fresh verified ADR-26 export and operator-owned off-host copy", () => {
    for (const required of [
      "fresh, complete ADR-26 export",
      "copy it off-host",
      "non-empty file",
      "passing ZIP integrity check",
      "identical SHA-256 on the Pi and off-host copies",
      "filename, UTC creation time, byte size, SHA-256",
      "off-host copy verified",
      "scheduled-backup log alone does not pass",
      "Restore is ADR-26 import of the complete export",
    ]) {
      expectText(runbook, required);
    }
  });

  it("pins registry-list, arm64 child, Pi platform, and RepoDigest proof", () => {
    for (const required of [
      "docker buildx imagetools inspect containrrr/watchtower:1.7.1",
      LIST_MEDIA_TYPE,
      WATCHTOWER_DIGEST,
      ARM64_CHILD,
      `WATCHTOWER_REF='${WATCHTOWER_REF}'`,
      'docker pull "$WATCHTOWER_REF"',
      "docker image inspect",
      "linux/arm64/v8",
      "RepoDigest carrying the same top-level digest",
      "Never compare or relabel a local image ID as a registry digest",
    ]) {
      expectText(runbook, required);
    }
  });

  it("uses service-scoped staged recreation while preserving data and trust", () => {
    const ordered = [
      "docker compose stop watchtower",
      "docker compose config --quiet",
      "docker compose up -d --no-deps draw",
      "edge:<pre-merge-full-SHA>",
      "docker compose up -d --no-deps watchtower",
    ];
    let previous = -1;
    for (const step of ordered) {
      const at = runbook.indexOf(step);
      expect(at).toBeGreaterThan(previous);
      previous = at;
    }
    expectText(runbook, "Never run `docker compose down -v`");
    expectText(runbook, "remove `draw_draw-data`, or recreate that volume");
    expectText(runbook, "do not start polling before Draw verification");
    expectText(runbook, "127.0.0.1:3001:3001");
    expectText(runbook, "one-hop `TRUST_PROXY=1`");
  });

  it("defines exact immutable manual rollback with schema-aware restore", () => {
    expectText(
      runbook,
      "ghcr.io/felixgeisler/draw:sha-<full-40-sha>@sha256:<verified-oci-index-digest>",
    );
    expectText(runbook, "Stop Watchtower first");
    expectText(runbook, "recreate only Draw");
    expectText(runbook, "AUTO_UPDATE=false");
    expectText(runbook, "matching ADR-26 complete export for that image/schema");
    expectText(runbook, "Never promise or infer automatic rollback or restoration");
  });
});

describe("merge-pending production acceptance", () => {
  it("pins traceability and keeps issue closure behind exact-digest human acceptance", () => {
    expectText(runbook, "`MERGE_PENDING_PRODUCTION_ACCEPTANCE`");
    expectText(runbook, "eeb0568faa31b6130f297f61172672a29aaa5afe53c612cbadeaa7d397d25461");
    expectText(runbook, "#280, and PR #283");
    expectText(runbook, "deliberately has no issue-closing keyword");
    expectText(runbook, "Merge leaves #286 open");
    expectText(contributing, "does not prove unattended replacement");
    expectText(runbook, "`ACCEPT <packet-sha256>`");
    expectText(runbook, "Nothing auto-closes");
  });

  it("requires bounded unattended replacement and the complete evidence packet", () => {
    expectText(runbook, "at most 10 minutes (two configured 300-second polls)");
    expectText(runbook, "do not invoke its HTTP update endpoint");
    expectText(runbook, "container ID changes");
    expectText(
      runbook,
      "`edge:<pre-merge-full-SHA>` to `edge:<full-docs-merge-SHA>`",
    );
    for (const evidence of [
      "protected-main check result",
      "GHCR visibility result",
      "workflow URL/ID/conclusion",
      "full merge SHA",
      "before/after container IDs and identities",
      "bounded replacement evidence",
      "backup non-secret identity",
      "whether any forbidden manual action occurred",
      "final PASS/FAIL",
    ]) {
      expectText(runbook, evidence);
    }
  });
});
