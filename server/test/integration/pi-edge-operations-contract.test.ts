import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Static operations contract for #286 / ADR-70. These files are deployed and
// executed by an operator, not by application code, so the focused test pins
// the exact opt-in boundary and fail-closed runbook without touching Docker,
// GHCR, GitHub settings, or the Pi.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const readCheckoutText = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
// Git may materialize text files with CRLF when core.autocrlf=true. Models and
// digest fixtures use the canonical LF deployment bytes committed to Git; the
// Pi runbook still checks raw bytes and never normalizes a deployed file.
const canonicalLf = (source: string) => source.replace(/\r\n/g, "\n");
const read = (relativePath: string) =>
  canonicalLf(readCheckoutText(relativePath));

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
const LIVE_COMPOSE =
  "docker compose --env-file /home/raspberry/draw/.env -f /home/raspberry/draw/docker-compose.yml";
const EDGE_COMPOSE =
  "docker compose --env-file /home/raspberry/draw/.env -f /home/raspberry/draw/docker-compose.pi-edge.yml";
const edgeRunbook = runbook.slice(
  runbook.indexOf("=== 7.5.1 Pi-only `edge` polling runbook (#286)"),
  runbook.indexOf("== 7.6 Summary"),
);
const anonymousPrefix =
  'env -u OCI_REGISTRY_USERNAME -u OCI_REGISTRY_PASSWORD DOCKER_CONFIG="$ANON_DOCKER_CONFIG"';
const privatePrefix =
  "env -u OCI_REGISTRY_USERNAME -u OCI_REGISTRY_PASSWORD DOCKER_CONFIG=/home/raspberry/draw/watchtower-docker-config";
const PUBLIC_MOUNT_MARKER =
  "      # - /home/raspberry/draw/watchtower-docker-config/config.json:/config.json:ro\n";
const PRIVATE_MOUNT =
  "      - /home/raspberry/draw/watchtower-docker-config/config.json:/config.json:ro\n";
const PUBLIC_COMPOSE_SHA256 =
  "7031afeddadcd924c893ad10f4f73a5a84b6ff63f69fce10d1f794f8378a970b";
const PRIVATE_COMPOSE_SHA256 =
  "0c162cc00286f0a2ee8aac51210eff1eeb4266b66ac9e41c7c3e884c4810cfd2";

type MountMode = "public" | "private";

const sha256 = (source: string) =>
  createHash("sha256").update(source, "utf8").digest("hex");
const occurrences = (source: string, value: string) =>
  source.split(value).length - 1;

function transitionMount(source: string, target: MountMode) {
  const from = target === "private" ? PUBLIC_MOUNT_MARKER : PRIVATE_MOUNT;
  const to = target === "private" ? PRIVATE_MOUNT : PUBLIC_MOUNT_MARKER;
  const sourceSha =
    target === "private" ? PUBLIC_COMPOSE_SHA256 : PRIVATE_COMPOSE_SHA256;
  const targetSha =
    target === "private" ? PRIVATE_COMPOSE_SHA256 : PUBLIC_COMPOSE_SHA256;

  if (
    sha256(source) !== sourceSha ||
    occurrences(source, from) !== 1 ||
    occurrences(source, to) !== 0
  ) {
    throw new Error("refusing transition: checksum or exact marker mismatch");
  }
  const updated = source.replace(from, to);
  if (sha256(updated) !== targetSha) {
    throw new Error("refusing transition: resulting checksum mismatch");
  }
  return updated;
}

function resolveConfigMounts(source: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "draw-edge-compose-"));
  const composeFile = path.join(directory, "docker-compose.pi-edge.yml");
  fs.writeFileSync(composeFile, source, "utf8");
  try {
    const output = execFileSync(
      "docker",
      ["compose", "-f", composeFile, "config", "--format", "json"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DRAW_PASSWORD: "contract-test-only",
          WATCHTOWER_TOKEN: "contract-test-only",
          DRAW_TAG: "edge",
          AUTO_UPDATE: "true",
          AUTO_UPDATE_INTERVAL_SECONDS: "300",
        },
      },
    );
    const model = JSON.parse(output) as {
      services: {
        watchtower: {
          volumes?: Array<{
            type?: string;
            source?: string;
            target?: string;
            read_only?: boolean;
          }>;
        };
      };
    };
    return (model.services.watchtower.volumes ?? []).filter(
      (volume) => volume.target === "/config.json",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

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
    expect(runbook).toContain("ADR-53");
    expectText(
      runbook,
      "ADR-53 governs the detached immutable-SHA publication and promotion evidence",
    );

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
  it("canonicalizes LF and CRLF fixtures to the same deployment bytes", () => {
    const syntheticCrlf = edgeCompose.replace(/\n/g, "\r\n");
    expect(syntheticCrlf).not.toBe(edgeCompose);

    for (const checkoutText of [edgeCompose, syntheticCrlf]) {
      const canonicalPublic = canonicalLf(checkoutText);
      expect(canonicalPublic).toBe(edgeCompose);
      expect(sha256(canonicalPublic)).toBe(PUBLIC_COMPOSE_SHA256);

      const canonicalPrivate = transitionMount(canonicalPublic, "private");
      expect(sha256(canonicalPrivate)).toBe(PRIVATE_COMPOSE_SHA256);
      expect(transitionMount(canonicalPrivate, "public")).toBe(edgeCompose);
    }

    expect(occurrences(edgeRunbook, "data = path.read_bytes()")).toBe(2);
    expectText(runbook, "sha256sum --check --strict");
  });

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
    expectText(runbook, "is the only Docker client config that host CLI GHCR pulls may use");
    expectText(runbook, "Failed initial or rotated access stops Watchtower");
    expect(edgeCompose).toMatch(
      /^\s*# - \/home\/raspberry\/draw\/watchtower-docker-config\/config\.json:\/config\.json:ro$/m,
    );
    expectText(runbook, "sole permitted divergence is the deterministic transition");
    expectText(runbook, "Do not use broad `sed`, a manual editor, or any other unreviewed mutation");
  });

  it("resolves public without the mount and private with exactly one read-only mount", () => {
    expect(sha256(edgeCompose)).toBe(PUBLIC_COMPOSE_SHA256);
    expect(occurrences(edgeCompose, PUBLIC_MOUNT_MARKER)).toBe(1);
    expect(occurrences(edgeCompose, PRIVATE_MOUNT)).toBe(0);
    expect(resolveConfigMounts(edgeCompose)).toEqual([]);

    const privateCompose = transitionMount(edgeCompose, "private");
    expect(resolveConfigMounts(privateCompose)).toEqual([
      expect.objectContaining({
        type: "bind",
        source:
          "/home/raspberry/draw/watchtower-docker-config/config.json",
        target: "/config.json",
        read_only: true,
      }),
    ]);
  });

  it("fails private transition mismatches and restores byte-exact public Compose", () => {
    for (const mismatched of [
      edgeCompose.replace(PUBLIC_MOUNT_MARKER, ""),
      edgeCompose.replace(PUBLIC_MOUNT_MARKER, PUBLIC_MOUNT_MARKER.repeat(2)),
      edgeCompose.replace(PUBLIC_MOUNT_MARKER, PRIVATE_MOUNT),
      `${edgeCompose}# unrelated mutation\n`,
    ]) {
      expect(() => transitionMount(mismatched, "private")).toThrow(
        /checksum or exact marker mismatch/,
      );
    }

    const privateCompose = transitionMount(edgeCompose, "private");
    const restored = transitionMount(privateCompose, "public");
    expect(restored).toBe(edgeCompose);
    expect(sha256(restored)).toBe(PUBLIC_COMPOSE_SHA256);
    expect(resolveConfigMounts(restored)).toEqual([]);
    expectText(runbook, "remove the now-empty `watchtower-docker-config` directory");
    expectText(runbook, "verify both paths are absent");
  });

  it("runs every public inspection with an empty OCI credential environment", () => {
    const inspectorCommands = edgeRunbook.match(
      /^env -u OCI_REGISTRY_USERNAME -u OCI_REGISTRY_PASSWORD node scripts\/inspect-oci-image\.mjs .+$/gm,
    );
    expect(inspectorCommands).toHaveLength(4);
    expectText(runbook, "Every repository inspector invocation must unset");
    expectText(runbook, "`OCI_REGISTRY_USERNAME` and `OCI_REGISTRY_PASSWORD`");
  });

  it("isolates anonymous Docker gates from host-default authentication", () => {
    for (const required of [
      'ANON_DOCKER_CONFIG="$(mktemp -d)"',
      `printf '%s\\n' '{"auths":{}}' > "$ANON_DOCKER_CONFIG/config.json"`,
      `${anonymousPrefix} docker buildx imagetools inspect containrrr/watchtower:1.7.1`,
      `${anonymousPrefix} docker pull "$WATCHTOWER_REF"`,
      `${anonymousPrefix} ${EDGE_COMPOSE} pull draw watchtower`,
      "prevents Docker from consulting a host-default login, credential store, or credential helper",
      "do not log out or alter that login",
      "Remove only the temporary anonymous directory when its gates and pulls finish",
    ]) {
      expectText(runbook, required);
    }
  });

  it("uses only the dedicated read-only config for private activation pulls", () => {
    for (const required of [
      "The anonymous and private branches are exclusive",
      "only after anonymous access fails",
      `${privatePrefix} ${EDGE_COMPOSE} pull draw watchtower`,
      "never copy it to, merge it with, or fall back to the host-default Docker login/config",
      "the dedicated file is the only credential source",
      "A failed private validation or pull leaves Watchtower stopped",
      "keep the dedicated directory and read-only Watchtower mount",
    ]) {
      expectText(runbook, required);
    }
  });

  it("forbids secret material and assigns fallback lifecycle ownership", () => {
    expectText(runbook, "coordinator owns initial private provisioning");
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

  it("uses the live file only for the initial stop and the edge file thereafter", () => {
    const invocations = edgeRunbook.match(/docker compose[^`\n]*/g) ?? [];
    expect(invocations.length).toBeGreaterThanOrEqual(12);
    for (const invocation of invocations) {
      expect(invocation).toMatch(
        /^docker compose --env-file \/home\/raspberry\/draw\/\.env -f \/home\/raspberry\/draw\/docker-compose(?:\.pi-edge)?\.yml /,
      );
    }
    expect(invocations.filter((command) => command.startsWith(LIVE_COMPOSE))).toEqual([
      `${LIVE_COMPOSE} stop watchtower`,
    ]);
    expectText(runbook, "Every Compose invocation from that point forward must explicitly select");
    expectText(runbook, "never rely on working-directory, `COMPOSE_FILE`, filename discovery, or the old live file");
  });

  it("stops and verifies the live Watchtower before installing or using the edge file", () => {
    const activation = compact(
      edgeRunbook.slice(edgeRunbook.indexOf("==== Safe activation")),
    );
    const ordered = [
      `${LIVE_COMPOSE} stop watchtower`,
      "docker inspect --format '{{.State.Running}}' watchtower",
      "returns `false`",
      "install the initial byte-exact reviewed public `docker-compose.pi-edge.yml`",
      "7031afeddadcd924c893ad10f4f73a5a84b6ff63f69fce10d1f794f8378a970b",
      "set only the approved host `.env` values",
      "perform exactly this reviewed transition before any edge-file Compose validation or Watchtower start",
      "EDGE_MOUNT_MODE=private python3",
      `${EDGE_COMPOSE} config --quiet draw watchtower`,
      "EXPECTED_CONFIG_MOUNT=\"$EXPECTED_CONFIG_MOUNT\" python3",
      `${anonymousPrefix} ${EDGE_COMPOSE} pull draw watchtower`,
      `${EDGE_COMPOSE} up -d --no-deps draw`,
      "edge:<pre-merge-full-SHA>",
      `${EDGE_COMPOSE} up -d --no-deps watchtower`,
    ];
    let previous = -1;
    for (const step of ordered) {
      const at = activation.indexOf(step);
      expect(at).toBeGreaterThan(previous);
      previous = at;
    }
    expect(activation.indexOf(EDGE_COMPOSE)).toBeGreaterThan(
      activation.indexOf("install the initial byte-exact reviewed public `docker-compose.pi-edge.yml`"),
    );
    expectText(runbook, "Before installing the edge file or editing any `.env` value");
    expect(activation.indexOf("EDGE_MOUNT_MODE=private python3")).toBeLessThan(
      activation.indexOf(`${EDGE_COMPOSE} config --quiet draw watchtower`),
    );
    expect(activation.indexOf(`${EDGE_COMPOSE} config --quiet draw watchtower`)).toBeLessThan(
      activation.indexOf(`${EDGE_COMPOSE} up -d --no-deps watchtower`),
    );
    expectText(runbook, "Public operation must resolve zero `/config.json` mounts");
    expectText(runbook, "Private operation must resolve exactly one bind");
    expectText(runbook, "with `read_only: true`");
    expectText(runbook, "A failed stop or any other result stops activation");
    expectText(runbook, `${EDGE_COMPOSE} down -v`);
    expectText(runbook, "remove `draw_draw-data`, or recreate that volume");
    expectText(runbook, "do not start polling before Draw verification");
    expectText(runbook, "127.0.0.1:3001:3001");
    expectText(runbook, "one-hop `TRUST_PROXY=1`");
  });

  it("covers isolated anonymous and private rollback pulls and fail-closed cleanup", () => {
    for (const required of [
      `${anonymousPrefix} ${EDGE_COMPOSE} pull draw`,
      `${privatePrefix} ${EDGE_COMPOSE} pull draw`,
      "If anonymous access fails, do not use host-default auth",
      "leave Watchtower stopped and the current Draw container untouched",
      "A failed pull leaves Watchtower stopped and the current Draw container untouched",
      "Remove the temporary anonymous directory after its use",
      "remove the dedicated directory only when private access is abandoned or no deployment depends on it",
    ]) {
      expectText(runbook, required);
    }
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

describe("preactivation and production-acceptance lifecycle", () => {
  it("keeps the PR preactivation-pending until criterion 5 permits transition", () => {
    for (const source of [runbook, contributing]) {
      expectText(source, "`PRE_ACTIVATION_EVIDENCE_PENDING`");
      expectText(source, "criterion 5");
      expectText(source, "`MERGE_PENDING_PRODUCTION_ACCEPTANCE`");
    }
    expectText(runbook, "it is not `MERGE_PENDING_PRODUCTION_ACCEPTANCE` and must not merge");
    expectText(runbook, "Only the successful pre-merge activation above permits");
    expectText(runbook, "eeb0568faa31b6130f297f61172672a29aaa5afe53c612cbadeaa7d397d25461");
    expectText(runbook, "#280, and PR #283");
    expectText(runbook, "deliberately has no issue-closing keyword");
    expectText(runbook, "Merge leaves #286 open");
    expectText(contributing, "Merge still does not prove unattended replacement");
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
