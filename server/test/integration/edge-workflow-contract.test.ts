import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Immutable commit publication contract (#277, ADR-53). Actions cannot be run
// safely from the unit suite, so these tests pin the committed workflow shape
// and exercise its first-write-wins state model without Docker, credentials, a
// registry, package mutation, or GitHub Actions execution.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const normalizeNewlines = (value: string) => value.replace(/\r\n/g, "\n");
const checkedOutEdge = fs.readFileSync(
  path.join(repoRoot, ".github/workflows/edge.yml"),
  "utf8",
);
const edge = normalizeNewlines(checkedOutEdge);

function workflowJob(
  workflow: string,
  name: string,
  nextName?: string,
): string {
  const normalizedWorkflow = normalizeNewlines(workflow);
  const start = normalizedWorkflow.indexOf(`\n  ${name}:`);
  if (start < 0) throw new Error(`missing workflow job: ${name}`);
  const end = nextName
    ? normalizedWorkflow.indexOf(`\n  ${nextName}:`, start)
    : normalizedWorkflow.length;
  if (end < 0) throw new Error(`missing workflow job: ${nextName}`);
  return normalizedWorkflow.slice(start, end);
}

const publicationJob = workflowJob(edge, "publication", "promotion");
const promotionJob = workflowJob(edge, "promotion");
const beforeSteps = publicationJob.slice(
  0,
  publicationJob.indexOf("\n    steps:"),
);
const actionReferences = edge.match(/uses:\s*[^\s]+/g) ?? [];
const publicationActions = publicationJob.match(/uses:\s*[^\s]+/g) ?? [];
const promotionActions = promotionJob.match(/uses:\s*[^\s]+/g) ?? [];
const publicationInspectionStep = step(
  "Inspect before any package mutation",
  publicationJob,
);
const publicationInspectionCleanupStep = step(
  "Remove initial inspection output",
  publicationJob,
);

function step(name: string, scope = edge): string {
  const normalizedScope = normalizeNewlines(scope);
  const start = normalizedScope.indexOf(`- name: ${name}`);
  if (start < 0) throw new Error(`missing workflow step: ${name}`);
  const next = normalizedScope.indexOf("\n      - name:", start + 1);
  return normalizedScope.slice(start, next < 0 ? normalizedScope.length : next);
}

function runScript(workflowStep: string): string {
  const normalizedStep = normalizeNewlines(workflowStep);
  const marker = "\n        run: |\n";
  const start = normalizedStep.indexOf(marker);
  if (start < 0) throw new Error("workflow step has no run script");
  return normalizedStep
    .slice(start + marker.length)
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
}

const shellPath = (value: string) => {
  const normalized = value.replaceAll("\\", "/");
  const drive = normalized.match(/^([A-Za-z]):\/(.*)$/);
  return drive === null
    ? normalized
    : `/${drive[1].toLowerCase()}/${drive[2]}`;
};
const shellQuote = (value: string) =>
  `'${value.replaceAll("'", "'\"'\"'")}'`;

function checked(command: string, args: string[], cwd?: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}): ${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

type WorkflowRun = {
  conclusion: string;
  event: string;
  headBranch: string;
  headRepository: string;
  repository: string;
  path: string;
};

const authorized = (run: WorkflowRun) =>
  run.conclusion === "success" &&
  run.event === "push" &&
  run.headBranch === "main" &&
  run.headRepository === run.repository &&
  run.path === ".github/workflows/ci.yml";

const validRun: WorkflowRun = {
  conclusion: "success",
  event: "push",
  headBranch: "main",
  headRepository: "FelixGeisler/draw",
  repository: "FelixGeisler/draw",
  path: ".github/workflows/ci.yml",
};

describe("edge workflow authorization and isolation", () => {
  it.each([
    ["LF", edge],
    ["synthetic CRLF", edge.replaceAll("\n", "\r\n")],
    ["checked-out newline form", checkedOutEdge],
  ])("normalizes %s workflow, job, and step text", (_name, workflow) => {
    const normalizedWorkflow = normalizeNewlines(workflow);
    const normalizedPublication = workflowJob(
      workflow,
      "publication",
      "promotion",
    );
    expect(normalizedWorkflow).toBe(edge);
    expect(normalizedPublication).toBe(publicationJob);
    expect(step("Check out the tested commit", normalizedPublication)).toBe(
      step("Check out the tested commit", publicationJob),
    );
    expect(
      step("Inspect before any package mutation", normalizedPublication),
    ).toBe(publicationInspectionStep);
    expect(
      step("Remove initial inspection output", normalizedPublication),
    ).toBe(publicationInspectionCleanupStep);
  });

  it("routes completed CI workflow runs but authorizes with all five predicates", () => {
    expect(edge).toMatch(
      /workflow_run:\s*[\s\S]*?workflows:\s*\["CI"\][\s\S]*?types:\s*\[completed\]/,
    );
    expect(beforeSteps).toContain(
      "github.event.workflow_run.conclusion == 'success'",
    );
    expect(beforeSteps).toContain("github.event.workflow_run.event == 'push'");
    expect(beforeSteps).toContain(
      "github.event.workflow_run.head_branch == 'main'",
    );
    expect(beforeSteps).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    );
    expect(beforeSteps).toContain(
      "github.event.workflow_run.path == '.github/workflows/ci.yml'",
    );
    expect(authorized(validRun)).toBe(true);
  });

  it.each([
    ["failed CI", { conclusion: "failure" }],
    ["pull request CI", { event: "pull_request" }],
    ["feature branch", { headBranch: "feature" }],
    ["fork", { headRepository: "attacker/draw" }],
    ["same-name workflow elsewhere", { path: ".github/workflows/not-ci.yml" }],
  ])("rejects %s before package-writing steps", (_name, patch) => {
    expect(authorized({ ...validRun, ...patch })).toBe(false);
  });

  it("treats every non-exact path as unauthorized, not the CI display name as authority", () => {
    for (const otherPath of [
      "ci.yml",
      ".github/workflows/CI.yml",
      ".github/workflows/ci.yaml",
      ".github/workflows/nested/ci.yml",
      ".github/workflows/release.yml",
      "",
    ]) {
      expect(authorized({ ...validRun, path: otherPath })).toBe(false);
    }
  });

  it("is detached from pull-request checks and checks out only the event head SHA", () => {
    const trigger = edge.slice(
      edge.indexOf("\non:"),
      edge.indexOf("\npermissions:"),
    );
    expect(trigger).not.toMatch(/^\s*pull_request:/m);
    expect(trigger).not.toMatch(/^\s*push:/m);
    const checkout = step("Check out the tested commit", publicationJob);
    expect(checkout).toContain(
      "ref: ${{ github.event.workflow_run.head_sha }}",
    );
    expect(checkout).not.toContain("github.sha");
    expect(checkout).not.toContain("github.ref");
  });
});

describe("edge workflow privilege, concurrency, and action supply chain", () => {
  it("uses read-only workflow permissions and the exact publication-job permissions", () => {
    const workflowScope = edge.slice(0, edge.indexOf("\njobs:"));
    expect(
      workflowScope.match(/permissions:\s*\n\s+contents:\s*read/g),
    ).toHaveLength(1);
    expect(workflowScope).not.toMatch(/^\s*(contents|packages):\s*write/m);
    expect(beforeSteps).toMatch(
      /permissions:\s*\n\s+contents:\s*read\s*\n\s+packages:\s*write\s*\n/,
    );
    expect(
      beforeSteps.match(/^[ \t]+[a-z-]+:[ \t]*(read|write)[ \t]*$/gm),
    ).toEqual(["      contents: read", "      packages: write"]);
    expect(beforeSteps).toContain("timeout-minutes: 60");
    expect(beforeSteps).not.toContain("env:");
  });

  it("serializes only the same SHA without cancellation", () => {
    const workflowScope = edge.slice(0, edge.indexOf("\njobs:"));
    expect(workflowScope).toContain(
      "group: edge-publication-${{ github.event.workflow_run.head_sha }}",
    );
    expect(workflowScope).toContain("cancel-in-progress: false");
  });

  it("sets up Node 22 after checkout and before both inspector calls", () => {
    const checkoutAt = edge.indexOf("- name: Check out the tested commit");
    const nodeAt = edge.indexOf(
      "- name: Set up Node for the repository inspector",
    );
    const firstInspectorAt = edge.indexOf("node scripts/inspect-oci-image.mjs");
    expect(checkoutAt).toBeGreaterThan(0);
    expect(nodeAt).toBeGreaterThan(checkoutAt);
    expect(firstInspectorAt).toBeGreaterThan(nodeAt);
    expect(
      step("Set up Node for the repository inspector", publicationJob),
    ).toContain("node-version: 22");
    expect(edge).not.toMatch(/npm (ci|install)/);
  });

  it("preserves the publication job's exact seven full-SHA action invocations", () => {
    expect(publicationActions).toEqual([
      "uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
      "uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
      "uses: docker/setup-qemu-action@c7c53464625b32c7a7e944ae62b3e17d2b600130",
      "uses: docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f",
      "uses: docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9",
      "uses: docker/metadata-action@c299e40c65443455700f0fdfc63efafe5b349051",
      "uses: docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8",
    ]);
    for (const reference of actionReferences)
      expect(reference).toMatch(/@[0-9a-f]{40}$/);
  });
});

describe("edge workflow inspector controller and credential boundary", () => {
  const initial = step("Inspect before any package mutation", publicationJob);
  const postPush = step("Verify the pushed digest", publicationJob);
  const login = step("Log in to GHCR", publicationJob);
  const build = step("Build and push the absent commit tag", publicationJob);

  it("invokes only the merged CLI in expected-revision mode, once before and once after push", () => {
    const invocations = edge.match(
      /node scripts\/inspect-oci-image\.mjs --image "\$TARGET" --expected-revision "\$SHA"/g,
    );
    expect(invocations).toHaveLength(2);
    expect(initial).toContain('case "$status" in');
    expect(initial).toMatch(/0\)[\s\S]*build=false/);
    expect(initial).toMatch(/3\)[\s\S]*build=true/);
    expect(initial).toMatch(/\*\)[\s\S]*exit 1/);
    expect(initial).toContain('keys.join(",") !== "digest,revision"');
    expect(initial).toContain("existing-digest=$digest");
  });

  it("binds inspector credentials only on the two inspector steps", () => {
    expect(publicationJob.match(/OCI_REGISTRY_USERNAME:/g)).toHaveLength(2);
    expect(publicationJob.match(/OCI_REGISTRY_PASSWORD:/g)).toHaveLength(2);
    for (const inspector of [initial, postPush]) {
      expect(inspector).toContain("OCI_REGISTRY_USERNAME: ${{ github.actor }}");
      expect(inspector).toContain(
        "OCI_REGISTRY_PASSWORD: ${{ secrets.GITHUB_TOKEN }}",
      );
      expect(inspector).not.toMatch(/echo[^\n]*(OCI_REGISTRY_|GITHUB_TOKEN)/);
      expect(inspector).not.toMatch(
        /inspect-oci-image[^\n]*(OCI_REGISTRY_|GITHUB_TOKEN)/,
      );
    }
    const withoutInspectors = publicationJob
      .replace(initial, "")
      .replace(postPush, "");
    expect(withoutInspectors).not.toContain("OCI_REGISTRY_");
  });

  it("gives the pinned login action exactly its three inputs and no direct build credentials", () => {
    expect(login).toMatch(
      /with:\s*\n\s+registry: ghcr\.io\s*\n\s+username: \$\{\{ github\.actor \}\}\s*\n\s+password: \$\{\{ secrets\.GITHUB_TOKEN \}\}\s*$/,
    );
    expect(build).not.toContain("GITHUB_TOKEN");
    expect(build).not.toContain("github.actor");
    expect(build).not.toContain("OCI_REGISTRY_");
    expect(build).not.toContain("password:");
    expect(build).not.toContain("username:");
  });

  it("requires valid post-push JSON and exact equality with the build action digest", () => {
    expect(build).toContain("id: build");
    expect(postPush).toContain(
      "EXPECTED_DIGEST: ${{ steps.build.outputs.digest }}",
    );
    expect(postPush).toContain('if [[ "$status" -ne 0 ]]');
    expect(postPush).toContain('keys.join(",") !== "digest,revision"');
    expect(postPush).toContain('[[ "$digest" != "$EXPECTED_DIGEST" ]]');
    expect(postPush).not.toMatch(/\b(delete|retry|repair|replace)\b/i);
  });
});

describe("publication byte-exact preflight and lifecycle", () => {
  it("captures inspector stdout directly in one owned mode-0600 file", () => {
    expect(publicationInspectionStep).toContain(
      'inspection_output="$(mktemp "$runner_root/publication-inspection.XXXXXXXXXX")"',
    );
    expect(publicationInspectionStep).toContain('chmod 0600 "$inspection_output"');
    expect(publicationInspectionStep).toContain("stat -c '%u'");
    expect(publicationInspectionStep).toContain("stat -c '%a'");
    expect(publicationInspectionStep).toContain(
      'node scripts/inspect-oci-image.mjs --image "$TARGET" --expected-revision "$SHA" > "$inspection_output"',
    );
    expect(publicationInspectionStep).toContain(
      'JSON.parse(fs.readFileSync(process.argv[1], "utf8"))',
    );
    expect(publicationInspectionStep).toContain(
      '[[ "$(stat -c \'%s\' -- "$inspection_output")" != 0 ]]',
    );
    expect(publicationInspectionStep).not.toMatch(
      /result="\$\(node scripts\/inspect-oci-image/,
    );
  });

  it("hands off safely, then runs cleanup immediately before every mutation-capable step", () => {
    expect(publicationInspectionStep).toContain(
      "trap cleanup_initialization EXIT",
    );
    expect(publicationInspectionStep).toContain(
      'printf \'inspection_output=%s\\n\' "$inspection_output" >> "$GITHUB_OUTPUT"',
    );
    expect(publicationInspectionStep).toContain("trap - EXIT INT TERM");
    expect(publicationInspectionCleanupStep).toContain("if: always()");
    expect(publicationInspectionCleanupStep).toContain(
      "INSPECTION_OUTPUT: ${{ steps.initial.outputs.inspection_output }}",
    );
    expect(publicationInspectionCleanupStep).toContain(
      'rm -f -- "$INSPECTION_OUTPUT"',
    );
    expect(publicationInspectionCleanupStep).toContain(
      '[[ ! -e "$INSPECTION_OUTPUT" && ! -L "$INSPECTION_OUTPUT" ]]',
    );
    const initialAt = publicationJob.indexOf(publicationInspectionStep);
    const cleanupAt = publicationJob.indexOf(publicationInspectionCleanupStep);
    const qemuAt = publicationJob.indexOf("- name: Set up QEMU");
    expect(cleanupAt).toBeGreaterThan(initialAt);
    expect(qemuAt).toBeGreaterThan(cleanupAt);
    expect(
      publicationJob.slice(initialAt + publicationInspectionStep.length, cleanupAt),
    ).not.toContain("- name:");
  });

  it("enables the mutation path only for exit 3 with exactly zero stdout bytes", () => {
    const execution = executePublicationController({ status: 3, stdout: Buffer.alloc(0) });
    expect(execution.initialStatus, execution.stderr).toBe(0);
    expect(execution.cleanupStatus, execution.stderr).toBe(0);
    expect(execution.outputs.build).toBe("true");
    expect(execution.mutationReached).toBe(true);
    expect(execution.temporaryFiles).toEqual([]);
  });

  it.each([
    ["LF only", Buffer.from("\n")],
    ["CRLF only", Buffer.from("\r\n")],
    ["whitespace ending in newlines", Buffer.from(" \t\r\n")],
    ["visible bytes", Buffer.from("CAPTURED_PAYLOAD_MUST_STAY_PRIVATE")],
    ["NUL and non-UTF-8 bytes", Buffer.from([0x00, 0xff, 0x80, 0x0a])],
  ])("fails closed on exit-3 %s without exposing or retaining the payload", (_name, payload) => {
    const execution = executePublicationController({ status: 3, stdout: payload });
    expect(execution.initialStatus).not.toBe(0);
    expect(execution.cleanupStatus, execution.stderr).toBe(0);
    expect(execution.outputs.build).toBeUndefined();
    expect(execution.mutationReached).toBe(false);
    expect(execution.temporaryFiles).toEqual([]);
    expect(execution.stderr.trim()).toBe(
      "absence inspection emitted unexpected output",
    );
  });

  it.each([1, 2, 4, 42])(
    "fails closed on inspector exit %i without mutation, disclosure, or residue",
    (status) => {
      const payload = `PRIVATE_EXIT_${status}_PAYLOAD`;
      const execution = executePublicationController({ status, stdout: payload });
      expect(execution.initialStatus).not.toBe(0);
      expect(execution.cleanupStatus, execution.stderr).toBe(0);
      expect(execution.outputs.build).toBeUndefined();
      expect(execution.mutationReached).toBe(false);
      expect(execution.temporaryFiles).toEqual([]);
      expect(execution.stderr.trim()).toBe(
        "initial image inspection failed closed",
      );
      expect(execution.stderr).not.toContain(payload);
    },
  );

  it("reuses exact valid exit-0 JSON from the file without mutation", () => {
    const revision = sha("a");
    const existingDigest = digest("1");
    const execution = executePublicationController({
      status: 0,
      stdout: JSON.stringify({ digest: existingDigest, revision }),
    });
    expect(execution.initialStatus, execution.stderr).toBe(0);
    expect(execution.cleanupStatus, execution.stderr).toBe(0);
    expect(execution.outputs.build).toBe("false");
    expect(execution.outputs["existing-digest"]).toBe(existingDigest);
    expect(execution.mutationReached).toBe(false);
    expect(execution.temporaryFiles).toEqual([]);
  });

  it.each([
    ["malformed JSON", "PRIVATE_MALFORMED_JSON"],
    ["extra key", JSON.stringify({ digest: digest("1"), revision: sha("a"), extra: true })],
    ["missing key", JSON.stringify({ digest: digest("1") })],
    ["invalid digest", JSON.stringify({ digest: "sha256:not-a-digest", revision: sha("a") })],
    ["mismatched revision", JSON.stringify({ digest: digest("1"), revision: sha("b") })],
  ])("fails closed on exit-0 %s with sanitized diagnostics and cleanup", (_name, payload) => {
    const execution = executePublicationController({ status: 0, stdout: payload });
    expect(execution.initialStatus).not.toBe(0);
    expect(execution.cleanupStatus, execution.stderr).toBe(0);
    expect(execution.outputs.build).toBeUndefined();
    expect(execution.outputs["existing-digest"]).toBeUndefined();
    expect(execution.mutationReached).toBe(false);
    expect(execution.temporaryFiles).toEqual([]);
    expect(execution.stderr.trim()).toBe(
      "initial image inspection returned invalid output",
    );
    expect(execution.stderr).not.toContain(payload);
  });

  it("uses the initialization trap before handoff and lets always-cleanup confirm no residue", () => {
    const execution = executePublicationController({
      status: 3,
      stdout: Buffer.alloc(0),
      failInitialization: true,
    });
    expect(execution.initialStatus).not.toBe(0);
    expect(execution.cleanupStatus, execution.stderr).toBe(0);
    expect(execution.outputs).toEqual({});
    expect(execution.mutationReached).toBe(false);
    expect(execution.temporaryFiles).toEqual([]);
  });

  it("rejects an unsafe handed-off file before the mutation boundary", () => {
    const execution = executePublicationController({
      status: 3,
      stdout: Buffer.alloc(0),
      tamperBeforeCleanup: true,
    });
    expect(execution.initialStatus, execution.stderr).toBe(0);
    expect(execution.cleanupStatus).not.toBe(0);
    expect(execution.mutationReached).toBe(false);
    expect(execution.stderr).toContain(
      "refusing to remove unsafe publication inspection output",
    );
    expect(execution.temporaryFiles).toHaveLength(1);
  });
});

describe("edge workflow absent build contract", () => {
  const target = step("Derive the one permitted target", publicationJob);
  const metadata = step("Derive immutable image metadata", publicationJob);
  const build = step("Build and push the absent commit tag", publicationJob);

  it("derives only one lowercase full-SHA tag", () => {
    expect(target).toContain('[[ "$EVENT_HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]');
    expect(target).toContain(
      "image=ghcr.io/felixgeisler/draw:sha-$EVENT_HEAD_SHA",
    );
    expect(metadata).toContain("flavor: latest=false");
    expect(metadata).toContain(
      "tags: type=raw,value=sha-${{ steps.target.outputs.sha }}",
    );
    expect(metadata.match(/^\s+tags:/gm)).toHaveLength(1);
  });

  it("builds exactly two platforms with the approved identity and no provenance", () => {
    expect(build).toContain("platforms: linux/amd64,linux/arm64");
    expect(build).toContain("provenance: false");
    expect(build).toMatch(
      /build-args:\s*\|\s*\n\s+DRAW_BUILD_CHANNEL=edge\s*\n\s+DRAW_BUILD_SHA=\$\{\{ steps\.target\.outputs\.sha \}\}/,
    );
    expect(build.match(/DRAW_BUILD_/g)).toHaveLength(2);
    expect(build).toMatch(
      /labels: \|\r?\n\s+org\.opencontainers\.image\.revision=\$\{\{ steps\.target\.outputs\.sha \}\}/,
    );
    expect(build).toMatch(
      /annotations: \|\r?\n\s+index:org\.opencontainers\.image\.revision=\$\{\{ steps\.target\.outputs\.sha \}\}/,
    );
  });

  it("contains no mutable/release tag producer or destructive package command", () => {
    const executable = publicationJob
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(executable).not.toMatch(/type=(semver|sha)/);
    expect(executable).not.toMatch(/value=(edge|latest|dryrun)/);
    expect(executable).not.toMatch(
      /gh release|docker manifest (rm|push)|docker buildx imagetools create/,
    );
    expect(executable).not.toMatch(/\b(delete|retry|repair|replace)\b/i);
    expect(build).toContain("push: true");
    expect(build).toContain("tags: ${{ steps.meta.outputs.tags }}");
  });
});

type Existing = { kind: "valid"; digest: string } | { kind: "invalid" };
type PostPush = "valid" | "mismatch" | "absent" | "failure";
type Mutation = {
  kind: "external-write" | "push";
  sha: string;
  digest: string;
};
type ModelResult = {
  state: "reused" | "published" | "wedged";
  digest?: string;
  residualRace: boolean;
};

class PublicationModel {
  readonly registry = new Map<string, Existing>();
  readonly mutations: Mutation[] = [];
  inspectorFailure = new Set<string>();

  run({
    sha,
    buildDigest,
    postPush = "valid",
    externalDigest,
  }: {
    sha: string;
    buildDigest: string;
    postPush?: PostPush;
    externalDigest?: string;
  }): ModelResult {
    if (this.inspectorFailure.has(sha))
      return { state: "wedged", residualRace: false };
    const observed = this.registry.get(sha);
    if (observed?.kind === "valid") {
      return { state: "reused", digest: observed.digest, residualRace: false };
    }
    if (observed?.kind === "invalid")
      return { state: "wedged", residualRace: false };

    let residualRace = false;
    if (externalDigest !== undefined) {
      residualRace = true;
      this.registry.set(sha, { kind: "valid", digest: externalDigest });
      this.mutations.push({
        kind: "external-write",
        sha,
        digest: externalDigest,
      });
    }

    // Only the authoritative-absence path reaches this one automation push.
    this.registry.set(sha, { kind: "valid", digest: buildDigest });
    this.mutations.push({ kind: "push", sha, digest: buildDigest });
    if (postPush !== "valid") {
      if (postPush === "absent") this.registry.delete(sha);
      return { state: "wedged", residualRace };
    }
    return { state: "published", digest: buildDigest, residualRace };
  }
}

const sha = (character: string) => character.repeat(40);
const digest = (character: string) => `sha256:${character.repeat(64)}`;

describe("immutable commit publication state model", () => {
  it("preserves at least three distinct commits that complete in reverse order", () => {
    const model = new PublicationModel();
    for (const character of ["c", "b", "a"]) {
      expect(
        model.run({ sha: sha(character), buildDigest: digest(character) })
          .state,
      ).toBe("published");
    }
    expect([...model.registry.keys()]).toEqual([sha("c"), sha("b"), sha("a")]);
    expect(model.mutations.filter(({ kind }) => kind === "push")).toHaveLength(
      3,
    );
  });

  it("reuses observed valid presence on same-SHA reruns without replacement push", () => {
    const model = new PublicationModel();
    model.run({ sha: sha("a"), buildDigest: digest("1") });
    const rerun = model.run({ sha: sha("a"), buildDigest: digest("2") });
    expect(rerun).toEqual({
      state: "reused",
      digest: digest("1"),
      residualRace: false,
    });
    expect(model.mutations.filter(({ kind }) => kind === "push")).toHaveLength(
      1,
    );
    expect(model.registry.get(sha("a"))).toEqual({
      kind: "valid",
      digest: digest("1"),
    });
  });

  it("allows only authoritative absence to build and wedges inspection/invalid-content failures", () => {
    const model = new PublicationModel();
    model.inspectorFailure.add(sha("a"));
    model.registry.set(sha("b"), { kind: "invalid" });
    expect(model.run({ sha: sha("a"), buildDigest: digest("1") }).state).toBe(
      "wedged",
    );
    expect(model.run({ sha: sha("b"), buildDigest: digest("2") }).state).toBe(
      "wedged",
    );
    expect(model.run({ sha: sha("c"), buildDigest: digest("3") }).state).toBe(
      "published",
    );
    expect(model.mutations).toEqual([
      { kind: "push", sha: sha("c"), digest: digest("3") },
    ]);
  });

  it.each(["mismatch", "absent", "failure"] as const)(
    "wedges post-push %s without an automated repair mutation",
    (postPush) => {
      const model = new PublicationModel();
      expect(
        model.run({ sha: sha("a"), buildDigest: digest("1"), postPush }).state,
      ).toBe("wedged");
      expect(model.mutations).toEqual([
        { kind: "push", sha: sha("a"), digest: digest("1") },
      ]);
    },
  );

  it("represents the accepted non-atomic external race and possible overwrite", () => {
    const model = new PublicationModel();
    const result = model.run({
      sha: sha("a"),
      buildDigest: digest("1"),
      externalDigest: digest("e"),
    });
    expect(result).toEqual({
      state: "published",
      digest: digest("1"),
      residualRace: true,
    });
    expect(model.mutations).toEqual([
      { kind: "external-write", sha: sha("a"), digest: digest("e") },
      { kind: "push", sha: sha("a"), digest: digest("1") },
    ]);
    expect(model.registry.get(sha("a"))).toEqual({
      kind: "valid",
      digest: digest("1"),
    });
  });
});

const promotionBeforeSteps = promotionJob.slice(
  0,
  promotionJob.indexOf("\n    steps:"),
);
const promotionCheckout = step(
  "Check out promotion scripts without persisted credentials",
  promotionJob,
);
const historyStep = step(
  "Establish isolated public main history",
  promotionJob,
);
const sourceStep = step("Inspect immutable current-main source", promotionJob);
const existingStep = step("Inspect existing edge state", promotionJob);
const ancestryStep = step(
  "Prove existing edge is not ahead of current main",
  promotionJob,
);
const mutationStep = step(
  "Promote verified digest to edge exactly once",
  promotionJob,
);
const postPromotionStep = step("Verify promoted edge state", promotionJob);
const cleanupStep = step("Remove isolated promotion history", promotionJob);

function promotionRunSteps(workflowJob: string): string[] {
  return normalizeNewlines(workflowJob)
    .split(/(?=^      - name: )/m)
    .filter(
      (candidate) =>
        /^      - name: /m.test(candidate) &&
        /^        run: \|/m.test(candidate),
    );
}

const forbiddenGitConfig = (key: string) =>
  /^(http(\..*)?\.extraheader|credential(\..*)?\.(helper|store)|url\..*\.(insteadof|pushinsteadof))$/i.test(
    key,
  );

// These harnesses execute the committed Bash controller bodies. Their wrappers
// replace only external inspector/network effects, so config gates, byte-level
// stdout handling, output handoff, and cleanup run exactly as committed.
type ControllerExecution = {
  status: number | null;
  output: Buffer;
  temporaryFiles: string[];
};

function executeInspectionController(
  workflowStep: string,
  inspectorStdout: string,
): ControllerExecution {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edge-controller-"));
  try {
    const runnerTemp = path.join(root, "runner");
    const output = path.join(root, "github-output");
    const wrapper = path.join(root, "inspector-node");
    const script = path.join(root, "controller.sh");
    fs.mkdirSync(runnerTemp);
    fs.writeFileSync(output, "");
    fs.writeFileSync(
      wrapper,
      `#!/usr/bin/env bash\n` +
        `"$REAL_NODE" -e 'process.stdout.write(Buffer.from(process.env.FAKE_STDOUT_BASE64, "base64"))'\n` +
        `exit "$FAKE_STATUS"\n`,
    );
    fs.chmodSync(wrapper, 0o700);
    const controller = runScript(workflowStep).replace(
      "node scripts/inspect-oci-image.mjs",
      `${shellQuote(shellPath(wrapper))} scripts/inspect-oci-image.mjs`,
    );
    fs.writeFileSync(script, `${controller}\n`, { mode: 0o700 });
    const result = spawnSync("bash", [shellPath(script)], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_STATUS: "3",
        FAKE_STDOUT_BASE64: Buffer.from(inspectorStdout).toString("base64"),
        GITHUB_OUTPUT: shellPath(output),
        REAL_NODE: shellPath(process.execPath),
        RUNNER_TEMP: shellPath(runnerTemp),
        TARGET_SHA: sha("a"),
      },
    });
    return {
      status: result.status,
      output: fs.readFileSync(output),
      temporaryFiles: fs.readdirSync(runnerTemp),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

type PublicationControllerExecution = {
  initialStatus: number | null;
  cleanupStatus: number | null;
  stderr: string;
  outputs: Record<string, string>;
  mutationReached: boolean;
  temporaryFiles: string[];
};

type PublicationControllerOptions = {
  status: number;
  stdout: Buffer | string;
  failInitialization?: boolean;
  tamperBeforeCleanup?: boolean;
};

function executePublicationController({
  status,
  stdout,
  failInitialization = false,
  tamperBeforeCleanup = false,
}: PublicationControllerOptions): PublicationControllerExecution {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edge-publication-controller-"));
  try {
    const runnerTemp = path.join(root, "runner");
    const output = path.join(root, "github-output");
    const wrapper = path.join(root, "inspector-node");
    const initialScript = path.join(root, "initial.sh");
    const cleanupScript = path.join(root, "cleanup.sh");
    fs.mkdirSync(runnerTemp);
    fs.writeFileSync(output, "");
    fs.writeFileSync(
      wrapper,
      `#!/usr/bin/env bash\n` +
        `"$REAL_NODE" -e 'process.stdout.write(Buffer.from(process.env.FAKE_STDOUT_BASE64, "base64"))'\n` +
        `exit "$FAKE_STATUS"\n`,
      { mode: 0o700 },
    );

    let initialController = runScript(publicationInspectionStep).replace(
      "node scripts/inspect-oci-image.mjs",
      `${shellQuote(shellPath(wrapper))} scripts/inspect-oci-image.mjs`,
    );
    if (failInitialization) {
      const chmod = 'chmod 0600 "$inspection_output"';
      if (!initialController.includes(chmod))
        throw new Error("publication initialization chmod contract changed");
      initialController = initialController.replace(chmod, "false");
    }
    fs.writeFileSync(initialScript, `${initialController}\n`, { mode: 0o700 });
    fs.writeFileSync(
      cleanupScript,
      `${runScript(publicationInspectionCleanupStep)}\n`,
      { mode: 0o700 },
    );

    const commonEnv = {
      ...process.env,
      FAKE_STATUS: String(status),
      FAKE_STDOUT_BASE64: Buffer.from(stdout).toString("base64"),
      GITHUB_OUTPUT: shellPath(output),
      REAL_NODE: shellPath(process.execPath),
      RUNNER_TEMP: shellPath(runnerTemp),
      SHA: sha("a"),
      TARGET: `ghcr.io/felixgeisler/draw:sha-${sha("a")}`,
    };
    const initial = spawnSync("bash", [shellPath(initialScript)], {
      cwd: repoRoot,
      encoding: "utf8",
      env: commonEnv,
    });
    const outputText = fs.readFileSync(output, "utf8");
    const outputs = Object.fromEntries(
      outputText
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );

    if (tamperBeforeCleanup) {
      const temporary = fs
        .readdirSync(runnerTemp)
        .find((entry) => entry.startsWith("publication-inspection."));
      if (temporary === undefined)
        throw new Error("publication output was not available for cleanup tamper");
      const temporaryPath = path.join(runnerTemp, temporary);
      fs.unlinkSync(temporaryPath);
      fs.mkdirSync(temporaryPath);
    }

    const cleanup = spawnSync("bash", [shellPath(cleanupScript)], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...commonEnv,
        INSPECTION_OUTPUT: outputs.inspection_output ?? "",
      },
    });
    const mutationReached =
      initial.status === 0 &&
      cleanup.status === 0 &&
      outputs.build === "true";
    return {
      initialStatus: initial.status,
      cleanupStatus: cleanup.status,
      stderr: `${initial.stderr}${cleanup.stderr}`,
      outputs,
      mutationReached,
      temporaryFiles: fs.readdirSync(runnerTemp),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

type HistoryGateOptions = {
  sourceUrl?: string;
  sourceKey?: string;
  bareKey?: string;
  value?: string;
  failFetch?: boolean;
};

type HistoryGateExecution = {
  status: number | null;
  stderr: string;
  output: string;
  fetchAudit: string[];
  runnerEntries: string[];
  namedRemotes: string[];
  remoteConfigKeys: string[];
  target: string;
};

function executeHistoryGate(
  {
    sourceUrl = "https://github.com/FelixGeisler/draw.git",
    sourceKey,
    bareKey,
    value = "blocked-value",
    failFetch = false,
  }: HistoryGateOptions = {},
  workflowStep = historyStep,
): HistoryGateExecution {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edge-history-gate-"));
  try {
    const source = path.join(root, "source");
    const fixture = path.join(root, "fixture");
    const runnerTemp = path.join(root, "runner");
    const home = path.join(root, "home");
    const bin = path.join(root, "bin");
    const output = path.join(root, "github-output");
    const audit = path.join(root, "fetch-audit");
    fs.mkdirSync(source);
    fs.mkdirSync(fixture);
    fs.mkdirSync(runnerTemp);
    fs.mkdirSync(home);
    fs.mkdirSync(bin);
    fs.writeFileSync(output, "");
    fs.writeFileSync(audit, "");

    checked("git", ["init"], source);
    checked("git", ["remote", "add", "origin", sourceUrl], source);
    if (sourceKey !== undefined)
      checked("git", ["config", "--local", sourceKey, value], source);

    checked("git", ["init"], fixture);
    checked("git", ["config", "user.name", "Contract Test"], fixture);
    checked("git", ["config", "user.email", "contract@example.invalid"], fixture);
    fs.writeFileSync(path.join(fixture, "fixture.txt"), "offline history\n");
    checked("git", ["add", "fixture.txt"], fixture);
    checked("git", ["commit", "-m", "offline fixture"], fixture);
    checked("git", ["branch", "-M", "main"], fixture);
    const target = checked("git", ["rev-parse", "HEAD"], fixture);
    const realGit = checked("bash", ["-lc", "command -v git"]);
    const wrapper = path.join(
      bin,
      process.platform === "win32" ? "git.exe" : "git",
    );
    const bareInjection = bareKey ?? "";
    fs.writeFileSync(
      wrapper,
      `#!/usr/bin/env bash\n` +
        `set -u\n` +
        `real_git=${shellQuote(realGit)}\n` +
        `audit=${shellQuote(shellPath(audit))}\n` +
        `fixture=${shellQuote(shellPath(fixture))}\n` +
        `bare_key=${shellQuote(bareInjection)}\n` +
        `bare_value=${shellQuote(value)}\n` +
        `is_init=false\n` +
        `bare=''\n` +
        `for ((index=1; index <= $#; index++)); do\n` +
        `  argument="\${!index}"\n` +
        `  [[ "$argument" == init ]] && is_init=true\n` +
        `  if [[ "$argument" == -C ]]; then next=$((index + 1)); bare="\${!next}"; fi\n` +
        `done\n` +
        `if [[ "$is_init" == true ]]; then\n` +
        `  "$real_git" "$@" || exit $?\n` +
        `  if [[ -n "$bare_key" ]]; then\n` +
        `    created="\${!#}"\n` +
        `    if [[ "$bare_key" == include.path && "$bare_value" == __remote_include__ ]]; then\n` +
        `      included="$created/injected.config"\n` +
        `      "$real_git" config -f "$included" remote.included.url https://evil.invalid/repository.git || exit $?\n` +
        `      "$real_git" -C "$created" config include.path "$included" || exit $?\n` +
        `    else\n` +
        `      "$real_git" -C "$created" config "$bare_key" "$bare_value" || exit $?\n` +
        `    fi\n` +
        `  fi\n` +
        `  exit 0\n` +
        `fi\n` +
        `for argument in "$@"; do\n` +
        `  if [[ "$argument" == fetch ]]; then\n` +
        `    printf '%s\\n' "$*" >> "$audit"\n` +
        (failFetch
          ? `    exit 71\n`
          : `    "$real_git" -C "$bare" -c credential.helper= fetch --no-tags "$fixture" 'refs/heads/main:refs/remotes/origin/main'\n    exit $?\n`) +
        `  fi\n` +
        `done\n` +
        `exec "$real_git" "$@"\n`,
    );
    fs.chmodSync(wrapper, 0o700);

    const script = path.join(root, "history.sh");
    fs.writeFileSync(
      script,
      `export PATH=${shellQuote(shellPath(bin))}:"$PATH"\n${runScript(workflowStep)}\n`,
      { mode: 0o700 },
    );
    const result = spawnSync("bash", [shellPath(script)], {
      cwd: source,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: shellPath(output),
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        HOME: shellPath(home),
        RUNNER_TEMP: shellPath(runnerTemp),
      },
    });
    const outputText = fs.readFileSync(output, "utf8");
    const area = outputText.match(/^area=(.+)$/m)?.[1];
    let namedRemotes: string[] = [];
    let remoteConfigKeys: string[] = [];
    if (area !== undefined) {
      const entry = fs.readdirSync(runnerTemp)[0];
      if (entry === undefined) throw new Error("history handoff omitted its area");
      const bare = path.join(runnerTemp, entry, "repository.git");
      namedRemotes = checked("git", ["-C", bare, "remote"])
        .split(/\r?\n/)
        .filter(Boolean);
      const remoteConfig = spawnSync(
        "git",
        ["-C", bare, "config", "--local", "--name-only", "--get-regexp", "^remote\\."],
        { encoding: "utf8" },
      );
      if (remoteConfig.status === 0) {
        remoteConfigKeys = remoteConfig.stdout.split(/\r?\n/).filter(Boolean);
      } else if (remoteConfig.status !== 1) {
        throw new Error(`bare remote-config inspection failed: ${remoteConfig.stderr}`);
      }
    }
    return {
      status: result.status,
      stderr: result.stderr,
      output: outputText,
      fetchAudit: fs
        .readFileSync(audit, "utf8")
        .split(/\r?\n/)
        .filter(Boolean),
      runnerEntries: fs.readdirSync(runnerTemp),
      namedRemotes,
      remoteConfigKeys,
      target,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

type AncestryGateOptions = {
  bareKey?: string;
  value?: string;
};

type AncestryGateExecution = {
  status: number | null;
  stderr: string;
  mergeBaseAudit: string[];
  reachedMutation: boolean;
};

function executeAncestryGate({
  bareKey,
  value = "https://evil.invalid/repository.git",
}: AncestryGateOptions = {}): AncestryGateExecution {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edge-ancestry-gate-"));
  try {
    const runnerTemp = path.join(root, "runner");
    fs.mkdirSync(runnerTemp);
    checked("bash", [
      "-lc",
      `umask 077; area=$(mktemp -d ${shellQuote(shellPath(runnerTemp))}/edge-promotion.XXXXXXXXXX); chmod 0700 "$area"`,
    ]);
    const areaEntry = fs.readdirSync(runnerTemp)[0];
    if (areaEntry === undefined) throw new Error("failed to create ancestry area");
    const area = path.join(runnerTemp, areaEntry);
    const bare = path.join(area, "repository.git");
    const fixture = path.join(root, "fixture");
    const template = path.join(area, "template");
    const bin = path.join(root, "bin");
    const mergeAudit = path.join(root, "merge-base-audit");
    const mutationAudit = path.join(root, "mutation-audit");
    fs.mkdirSync(path.join(area, "home"));
    fs.mkdirSync(template);
    fs.mkdirSync(fixture);
    fs.mkdirSync(bin);
    fs.writeFileSync(mergeAudit, "");
    fs.writeFileSync(mutationAudit, "");

    checked("git", ["init"], fixture);
    checked("git", ["config", "user.name", "Contract Test"], fixture);
    checked("git", ["config", "user.email", "contract@example.invalid"], fixture);
    fs.writeFileSync(path.join(fixture, "fixture.txt"), "offline history\n");
    checked("git", ["add", "fixture.txt"], fixture);
    checked("git", ["commit", "-m", "offline fixture"], fixture);
    checked("git", ["branch", "-M", "main"], fixture);
    const target = checked("git", ["rev-parse", "HEAD"], fixture);
    checked("git", ["init", "--bare", `--template=${template}`, bare]);
    checked("git", [
      "-C",
      bare,
      "-c",
      "credential.helper=",
      "fetch",
      "--no-tags",
      fixture,
      "refs/heads/main:refs/remotes/origin/main",
    ]);
    if (bareKey === "include.path" && value === "__remote_include__") {
      const included = path.join(area, "injected.config");
      checked("git", ["config", "-f", included, "remote.included.url", "https://evil.invalid/repository.git"]);
      checked("git", ["-C", bare, "config", bareKey, included]);
    } else if (bareKey !== undefined) {
      checked("git", ["-C", bare, "config", bareKey, value]);
    }

    const realGit = checked("bash", ["-lc", "command -v git"]);
    const wrapper = path.join(
      bin,
      process.platform === "win32" ? "git.exe" : "git",
    );
    fs.writeFileSync(
      wrapper,
      `#!/usr/bin/env bash\n` +
        `real_git=${shellQuote(realGit)}\n` +
        `audit=${shellQuote(shellPath(mergeAudit))}\n` +
        `for argument in "$@"; do\n` +
        `  if [[ "$argument" == merge-base ]]; then printf '%s\\n' "$*" >> "$audit"; fi\n` +
        `done\n` +
        `exec "$real_git" "$@"\n`,
    );
    fs.chmodSync(wrapper, 0o700);

    const script = path.join(root, "ancestry.sh");
    fs.writeFileSync(
      script,
      `export PATH=${shellQuote(shellPath(bin))}:"$PATH"\n` +
        `umask 077\n` +
        `chmod 0700 ${shellQuote(shellPath(area))}\n` +
        `${runScript(ancestryStep)}\n` +
        `printf 'reached\\n' >> ${shellQuote(shellPath(mutationAudit))}\n`,
      { mode: 0o700 },
    );
    const result = spawnSync("bash", [shellPath(script)], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        AREA: shellPath(area),
        EDGE_REVISION: target,
        RUNNER_TEMP: shellPath(runnerTemp),
        TARGET_SHA: target,
      },
    });
    return {
      status: result.status,
      stderr: result.stderr,
      mergeBaseAudit: fs
        .readFileSync(mergeAudit, "utf8")
        .split(/\r?\n/)
        .filter(Boolean),
      reachedMutation: fs.readFileSync(mutationAudit, "utf8") === "reached\n",
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("promotion workflow authorization, runner, and action boundary", () => {
  it("is a separate globally serialized job after publication with all five gates", () => {
    expect(promotionBeforeSteps).toContain("needs: publication");
    for (const predicate of [
      "github.event.workflow_run.conclusion == 'success'",
      "github.event.workflow_run.event == 'push'",
      "github.event.workflow_run.head_branch == 'main'",
      "github.event.workflow_run.head_repository.full_name == github.repository",
      "github.event.workflow_run.path == '.github/workflows/ci.yml'",
    ]) {
      expect(promotionBeforeSteps).toContain(predicate);
    }
    expect(promotionBeforeSteps).toContain("runs-on: ubuntu-24.04");
    expect(promotionBeforeSteps).toMatch(
      /permissions:\s*\n\s+contents: read\s*\n\s+packages: write\s*\n/,
    );
    expect(promotionBeforeSteps).toContain("timeout-minutes: 60");
    expect(promotionBeforeSteps).toMatch(
      /concurrency:\s*\n\s+group: edge-promotion\s*\n\s+cancel-in-progress: false/,
    );
    expect(beforeSteps).toContain("runs-on: ubuntu-latest");
  });

  it.each([
    "ubuntu-latest",
    "self-hosted",
    "windows-latest",
    "macos-latest",
    "",
  ])("rejects the non-contract promotion runner %j", (runner) =>
    expect(runner).not.toBe("ubuntu-24.04"),
  );

  it("declares exact Bash on every promotion shell step", () => {
    const runSteps = promotionRunSteps(promotionJob);
    expect(
      runSteps.map((candidate) => candidate.match(/- name: ([^\r\n]+)/)?.[1]),
    ).toEqual([
      "Establish isolated public main history",
      "Inspect immutable current-main source",
      "Inspect existing edge state",
      "Prove existing edge is not ahead of current main",
      "Promote verified digest to edge exactly once",
      "Verify promoted edge state",
      "Remove isolated promotion history",
    ]);
    for (const candidate of runSteps)
      expect(candidate).toMatch(/^        shell: bash$/m);
    for (const invalid of ["", "sh", "pwsh", "cmd"])
      expect(invalid).not.toBe("bash");
  });

  it("uses only the four approved pinned promotion actions", () => {
    expect(promotionActions).toEqual([
      "uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
      "uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
      "uses: docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f",
      "uses: docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9",
    ]);
    expect(actionReferences).toHaveLength(11);
    for (const reference of promotionActions)
      expect(reference).toMatch(/@[0-9a-f]{40}$/);
  });
});

describe("promotion history authority and lifecycle contract", () => {
  it("checks out scripts without persistence and immediately performs the hygiene gate", () => {
    expect(promotionCheckout).toContain(
      "ref: ${{ github.event.workflow_run.head_sha }}",
    );
    expect(promotionCheckout).toContain("persist-credentials: false");
    expect(promotionCheckout).toContain("fetch-depth: 0");
    expect(promotionCheckout).not.toMatch(/^\s+token:/m);
    expect(promotionJob.match(/^      - name: .+$/gm)?.slice(0, 2)).toEqual([
      "      - name: Check out promotion scripts without persisted credentials",
      "      - name: Establish isolated public main history",
    ]);
    expect(
      promotionJob.indexOf("- name: Establish isolated public main history"),
    ).toBeLessThan(promotionJob.indexOf("node scripts/inspect-oci-image.mjs"));
    expect(
      promotionJob.indexOf("- name: Establish isolated public main history"),
    ).toBeLessThan(promotionJob.indexOf("merge-base --is-ancestor"));
  });

  it("allows only the two exact source origins and rejects every credential/rewrite key", () => {
    expect(historyStep).toContain(
      "readonly source_url='https://github.com/FelixGeisler/draw'",
    );
    expect(historyStep).toContain(
      "readonly public_url='https://github.com/FelixGeisler/draw.git'",
    );
    expect(historyStep).toContain(
      'if [[ "$candidate" == "$public_url" ]]; then',
    );
    expect(historyStep).toContain('candidate="${candidate%.git}"');
    expect(historyStep).toContain("git remote get-url --all origin");
    expect(historyStep).toContain("git remote get-url --all --push origin");
    for (const key of [
      "http.extraheader",
      "http.https://github.com/.extraheader",
      "credential.helper",
      "credential.https://github.com.helper",
      "credential.store",
      "url.ssh://git@github.com/.insteadof",
      "url.https://mirror/.pushinsteadof",
    ]) {
      expect(forbiddenGitConfig(key)).toBe(true);
    }
    for (const key of ["core.bare", "user.email"]) {
      expect(forbiddenGitConfig(key)).toBe(false);
    }
    expect(historyStep.match(/reject_forbidden_config/g)).toHaveLength(2);
    expect(historyStep).toContain(
      "--get-regexp '^(remote|include|includeif|submodule)\\.'",
    );
    expect(historyStep.match(/reject_bare_remote_state/g)).toHaveLength(2);
    expect(ancestryStep).toContain(
      "--get-regexp '^(remote|include|includeif|submodule)\\.'",
    );
    expect(ancestryStep.match(/reject_bare_remote_state/g)).toHaveLength(2);
    expect(historyStep).toContain(
      'bare_forbidden="$(isolated_git -C "$bare" config --show-origin --get-regexp "$forbidden" 2>&1)"',
    );
  });

  it("creates one owned 0700 area, empty HOME/template, and an isolated bare repository", () => {
    expect(historyStep).toContain(
      'mktemp -d "$runner_root/edge-promotion.XXXXXXXXXX"',
    );
    expect(historyStep).toContain('chmod 0700 "$area"');
    expect(historyStep).toContain("stat -c '%u'");
    expect(historyStep).toContain("stat -c '%a'");
    expect(historyStep).toContain('mkdir -- "$area/home" "$area/template"');
    expect(historyStep).toContain('env -i PATH="$PATH" HOME="$area/home"');
    expect(historyStep).toContain(
      "GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null",
    );
    expect(historyStep).toContain(
      "GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false",
    );
    expect(historyStep).toContain(
      'init --bare --template="$area/template" "$bare"',
    );
    expect(historyStep).not.toContain("GITHUB_TOKEN");
    expect(historyStep).not.toContain("OCI_REGISTRY_");
  });

  it("fetches only literal public main into the isolated ref without a remote or fallback", () => {
    expect(historyStep).toMatch(
      /-c credential\.helper= fetch --no-tags[\s\\]*\n\s+'https:\/\/github\.com\/FelixGeisler\/draw\.git'[\s\\]*\n\s+'refs\/heads\/main:refs\/remotes\/origin\/main'/,
    );
    expect(historyStep).not.toMatch(
      /remote add|Authorization|GITHUB_TOKEN|git -C \.|git fetch origin/,
    );
    expect(historyStep).toContain("'refs/remotes/origin/main^{commit}'");
    expect(historyStep.lastIndexOf("reject_bare_remote_state")).toBeGreaterThan(
      historyStep.indexOf("fetch --no-tags"),
    );
    expect(historyStep.lastIndexOf("reject_bare_remote_state")).toBeLessThan(
      historyStep.indexOf("target=\"$(isolated_git"),
    );
    expect(historyStep).not.toContain("workflow_run.head_sha");
    expect(historyStep).not.toMatch(/retry|fallback/i);
  });

  it.each([
    ["LF workflow source", historyStep],
    ["synthetic CRLF workflow source", historyStep.replaceAll("\n", "\r\n")],
    [
      "checked-out workflow source",
      step("Establish isolated public main history", checkedOutEdge),
    ],
  ])(
    "extracts and executes the real gate from %s after newline normalization",
    (_name, workflowStep) => {
      const execution = executeHistoryGate({}, workflowStep);
      expect(execution.status, execution.stderr).toBe(0);
      expect(execution.output).toMatch(
        new RegExp(`^area=.+\\ntarget=${execution.target}\\n$`),
      );
      expect(execution.fetchAudit).toHaveLength(1);
      expect(execution.fetchAudit[0]).toContain(
        "-c credential.helper= fetch --no-tags",
      );
      expect(execution.fetchAudit[0]).toContain(
        "https://github.com/FelixGeisler/draw.git refs/heads/main:refs/remotes/origin/main",
      );
      expect(execution.runnerEntries).toHaveLength(1);
      expect(execution.namedRemotes).toEqual([]);
      expect(execution.remoteConfigKeys).toEqual([]);
    },
  );

  it.each([
    "https://github.com/FelixGeisler/draw",
    "https://github.com/FelixGeisler/draw.git",
  ])("executes the actual source gate for approved origin %s", (sourceUrl) => {
    const execution = executeHistoryGate({ sourceUrl });
    expect(execution.status, execution.stderr).toBe(0);
    expect(execution.output).toMatch(
      new RegExp(`^area=.+\\ntarget=${execution.target}\\n$`),
    );
    expect(execution.fetchAudit).toEqual([
      expect.stringContaining(
        "https://github.com/FelixGeisler/draw.git refs/heads/main:refs/remotes/origin/main",
      ),
    ]);
  });

  it.each([
    ["alternate scheme", "http://github.com/FelixGeisler/draw"],
    ["Git transport scheme", "git://github.com/FelixGeisler/draw.git"],
    ["alternate host", "https://www.github.com/FelixGeisler/draw.git"],
    ["explicit port", "https://github.com:443/FelixGeisler/draw.git"],
    ["path suffix", "https://github.com/FelixGeisler/draw/"],
    ["different path", "https://github.com/FelixGeisler/draw-other.git"],
    ["query", "https://github.com/FelixGeisler/draw.git?ref=main"],
    ["fragment", "https://github.com/FelixGeisler/draw.git#main"],
    ["userinfo", "https://FelixGeisler@github.com/FelixGeisler/draw.git"],
    [
      "credential",
      "https://FelixGeisler:secret@github.com/FelixGeisler/draw.git",
    ],
    ["owner case variation", "https://github.com/felixgeisler/draw.git"],
    ["repository case variation", "https://github.com/FelixGeisler/Draw.git"],
    ["suffix case variation", "https://github.com/FelixGeisler/draw.GIT"],
    ["repeated suffix", "https://github.com/FelixGeisler/draw.git.git"],
  ])("rejects actual source origin %s", (_name, sourceUrl) => {
    const execution = executeHistoryGate({ sourceUrl });
    expect(execution.status).not.toBe(0);
    expect(execution.output).toBe("");
    expect(execution.fetchAudit).toEqual([]);
    expect(execution.runnerEntries).toEqual([]);
  });

  it.each([
    ["even an exact literal origin", "remote.origin.url", "https://github.com/FelixGeisler/draw.git"],
    ["an alternate named remote", "remote.backup.url", "https://github.com/FelixGeisler/draw.git"],
    ["a malicious origin URL", "remote.origin.url", "https://evil.invalid/repository.git"],
    ["included named-remote config", "include.path", "__remote_include__"],
    ["submodule URL config", "submodule.injection.url", "https://evil.invalid/repository.git"],
  ])("rejects %s after the bounded direct fetch and before handoff", (_name, bareKey, value) => {
    const execution = executeHistoryGate({ bareKey, value });
    expect(execution.status).not.toBe(0);
    expect(execution.output).toBe("");
    expect(execution.fetchAudit).toHaveLength(1);
    expect(execution.runnerEntries).toEqual([]);
  });

  it("stops an offline fetch failure with no handoff or fallback", () => {
    const execution = executeHistoryGate({ failFetch: true });
    expect(execution.status, execution.stderr).toBe(71);
    expect(execution.output).toBe("");
    expect(execution.fetchAudit).toHaveLength(1);
    expect(execution.runnerEntries).toEqual([]);
  });

  it.each([
    ["global extraheader", "http.extraheader", "Authorization: global"],
    [
      "URL-specific extraheader",
      "http.https://github.com/.extraheader",
      "Authorization: injected",
    ],
    ["credential helper", "credential.helper", "store"],
    ["credential store", "credential.store", "/tmp/injected-credentials"],
    ["insteadOf", "url.https://mirror.invalid/.insteadof", "https://github.com/"],
    ["pushInsteadOf", "url.https://mirror.invalid/.pushinsteadof", "https://github.com/"],
  ])("rejects actual source %s configuration before fetch", (_name, key, value) => {
    const execution = executeHistoryGate({ sourceKey: key, value });
    expect(execution.status).not.toBe(0);
    expect(execution.output).toBe("");
    expect(execution.fetchAudit).toEqual([]);
    expect(execution.runnerEntries).toEqual([]);
  });

  it.each([
    ["global extraheader", "http.extraheader", "Authorization: global"],
    [
      "URL-specific extraheader",
      "http.https://github.com/.extraheader",
      "Authorization: injected",
    ],
    ["credential helper", "credential.helper", "store"],
    ["credential store", "credential.store", "/tmp/injected-credentials"],
    ["insteadOf", "url.https://mirror.invalid/.insteadof", "https://github.com/"],
    ["pushInsteadOf", "url.https://mirror.invalid/.pushinsteadof", "https://github.com/"],
  ])("rejects actual bare %s configuration before fetch", (_name, key, value) => {
    const execution = executeHistoryGate({ bareKey: key, value });
    expect(execution.status).not.toBe(0);
    expect(execution.output).toBe("");
    expect(execution.fetchAudit).toEqual([]);
    expect(execution.runnerEntries).toEqual([]);
  });

  it("executes clean no-remote ancestry and reaches the downstream boundary", () => {
    const execution = executeAncestryGate();
    expect(execution.status, execution.stderr).toBe(0);
    expect(execution.mergeBaseAudit).toHaveLength(1);
    expect(execution.reachedMutation).toBe(true);
  });

  it.each([
    ["even an exact literal origin", "remote.origin.url", "https://github.com/FelixGeisler/draw.git"],
    ["an alternate named remote", "remote.backup.url", "https://github.com/FelixGeisler/draw.git"],
    ["a malicious origin URL", "remote.origin.url", "https://evil.invalid/repository.git"],
    ["included named-remote config", "include.path", "__remote_include__"],
    ["submodule URL config", "submodule.injection.url", "https://evil.invalid/repository.git"],
  ])("revalidates and rejects %s immediately before ancestry and mutation", (_name, bareKey, value) => {
    const execution = executeAncestryGate({ bareKey, value });
    expect(execution.status).not.toBe(0);
    expect(execution.mergeBaseAudit).toEqual([]);
    expect(execution.reachedMutation).toBe(false);
  });

  it("hands off one exact persistent path, revalidates it, and cleans it last with always", () => {
    expect(historyStep).toContain("trap cleanup_initialization EXIT");
    expect(historyStep).toContain("trap 'exit 130' INT");
    expect(historyStep).toContain("trap 'exit 143' TERM");
    expect(historyStep).toContain(
      'printf \'area=%s\\n\' "$area" >> "$GITHUB_OUTPUT"',
    );
    expect(historyStep).toContain(
      'printf \'target=%s\\n\' "$target" >> "$GITHUB_OUTPUT"',
    );
    expect(historyStep).toContain("trap - EXIT INT TERM");
    expect(ancestryStep).toContain("AREA: ${{ steps.history.outputs.area }}");
    expect(ancestryStep).toContain("edge-promotion.??????????");
    expect(ancestryStep).toContain("stat -c '%u'");
    expect(ancestryStep).toContain("stat -c '%a'");
    expect(cleanupStep).toContain("if: always()");
    expect(cleanupStep).toContain('rm -rf -- "$AREA"');
    expect(promotionJob.trimEnd().endsWith(cleanupStep.trimEnd())).toBe(true);
  });
});

type InspectionResult =
  | { kind: "valid"; digest: string; revision: string }
  | { kind: "absent" }
  | { kind: "invalid" };

function classifyInspection(
  status: number,
  stdout: string,
  expected?: string,
): InspectionResult {
  if (status === 3)
    return stdout === "" ? { kind: "absent" } : { kind: "invalid" };
  if (status !== 0) return { kind: "invalid" };
  try {
    const value = JSON.parse(stdout) as Record<string, unknown>;
    if (
      Object.keys(value).sort().join(",") !== "digest,revision" ||
      typeof value.digest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(value.digest) ||
      typeof value.revision !== "string" ||
      !/^[0-9a-f]{40}$/.test(value.revision) ||
      (expected !== undefined && value.revision !== expected)
    ) {
      return { kind: "invalid" };
    }
    return { kind: "valid", digest: value.digest, revision: value.revision };
  } catch {
    return { kind: "invalid" };
  }
}

describe("promotion inspector, credential, and mutation contract", () => {
  it("orders setup after isolated fetch and before all three inspector calls", () => {
    const historyAt = promotionJob.indexOf(
      "- name: Establish isolated public main history",
    );
    const nodeAt = promotionJob.indexOf(
      "- name: Set up Node for promotion inspection",
    );
    const inspectorAt = promotionJob.indexOf(
      "node scripts/inspect-oci-image.mjs",
    );
    expect(historyAt).toBeGreaterThan(0);
    expect(nodeAt).toBeGreaterThan(historyAt);
    expect(inspectorAt).toBeGreaterThan(nodeAt);
    expect(
      step("Set up Node for promotion inspection", promotionJob),
    ).toContain("node-version: 22");
  });

  it("classifies only exact success JSON and output-free exit 3 as valid controller states", () => {
    const revision = sha("a");
    const exact = JSON.stringify({ digest: digest("1"), revision });
    expect(classifyInspection(0, exact, revision)).toEqual({
      kind: "valid",
      digest: digest("1"),
      revision,
    });
    expect(classifyInspection(3, "", revision)).toEqual({ kind: "absent" });
    for (const [status, stdout] of [
      [1, exact],
      [2, exact],
      [4, exact],
      [3, "unexpected"],
      [0, "not json"],
      [0, JSON.stringify({ digest: digest("1"), revision, extra: true })],
      [0, JSON.stringify({ digest: digest("1"), revision: sha("b") })],
    ] as const) {
      expect(classifyInspection(status, stdout, revision)).toEqual({
        kind: "invalid",
      });
    }
    expect(sourceStep).toMatch(/3\)[\s\S]*present=false/);
    expect(sourceStep).toMatch(/\*\)[\s\S]*exit 1/);
    expect(existingStep).toContain("--image 'ghcr.io/felixgeisler/draw:edge'");
    expect(existingStep).not.toContain("--expected-revision");
  });

  it.each([
    ["source", sourceStep],
    ["existing edge", existingStep],
  ])("executes the actual %s controller and accepts only a zero-byte exit-3 output", (_name, controller) => {
    const execution = executeInspectionController(controller, "");
    expect(execution.status).toBe(0);
    expect(execution.output.toString("utf8")).toBe("present=false\n");
    expect(execution.temporaryFiles).toEqual([]);
  });

  it.each([
    ["source", sourceStep, "\n"],
    ["source", sourceStep, " "],
    ["source", sourceStep, "\t\n"],
    ["existing edge", existingStep, "\n"],
    ["existing edge", existingStep, " "],
    ["existing edge", existingStep, "\t\n"],
  ])("fails the actual %s controller on exit-3 stdout %j without downstream outputs", (_name, controller, stdout) => {
    const execution = executeInspectionController(controller, stdout);
    expect(execution.status).not.toBe(0);
    expect(execution.output).toHaveLength(0);
    expect(execution.temporaryFiles).toEqual([]);
  });

  it("captures absence stdout in owned temporary files instead of command substitution", () => {
    for (const controller of [sourceStep, existingStep]) {
      expect(controller).toContain('inspection_output="$(mktemp "$RUNNER_TEMP/');
      expect(controller).toContain('trap cleanup_inspection_output EXIT');
      expect(controller).toContain('[[ -f "$inspection_output" && ! -s "$inspection_output" ]]');
      expect(controller).not.toMatch(/result="\$\(node scripts\/inspect-oci-image/);
    }
  });

  it("binds credentials only to each inspector and the exact login inputs", () => {
    expect(promotionJob.match(/OCI_REGISTRY_USERNAME:/g)).toHaveLength(3);
    expect(promotionJob.match(/OCI_REGISTRY_PASSWORD:/g)).toHaveLength(3);
    for (const inspector of [sourceStep, existingStep, postPromotionStep]) {
      expect(inspector).toContain("OCI_REGISTRY_USERNAME: ${{ github.actor }}");
      expect(inspector).toContain(
        "OCI_REGISTRY_PASSWORD: ${{ secrets.GITHUB_TOKEN }}",
      );
      expect(inspector).not.toMatch(/echo[^\n]*(GITHUB_TOKEN|OCI_REGISTRY_)/);
    }
    const login = step("Log in for edge promotion", promotionJob);
    expect(login).toMatch(
      /with:\s*\n\s+registry: ghcr\.io\s*\n\s+username: \$\{\{ github\.actor \}\}\s*\n\s+password: \$\{\{ secrets\.GITHUB_TOKEN \}\}\s*$/,
    );
    for (const noCredentialStep of [historyStep, ancestryStep, mutationStep]) {
      expect(noCredentialStep).not.toMatch(
        /GITHUB_TOKEN|OCI_REGISTRY_|password:|username:/,
      );
    }
    expect(promotionBeforeSteps).not.toContain("env:");
  });

  it("uses only isolated fetched history for exact commit ancestry", () => {
    expect(ancestryStep).toContain("git --no-replace-objects");
    expect(ancestryStep).toContain("refs/replace/");
    expect(ancestryStep).toContain("objects/info/alternates");
    expect(ancestryStep).toContain("'refs/remotes/origin/main^{commit}'");
    expect(ancestryStep).toContain('cat-file -t "$EDGE_REVISION"');
    expect(ancestryStep).toContain(')" == commit ]]');
    expect(ancestryStep).toContain(
      'merge-base --is-ancestor "$EDGE_REVISION" "$TARGET_SHA"',
    );
    expect(ancestryStep.lastIndexOf("reject_bare_remote_state")).toBeGreaterThan(
      ancestryStep.indexOf('cat-file -t "$EDGE_REVISION"'),
    );
    expect(ancestryStep.lastIndexOf("reject_bare_remote_state")).toBeLessThan(
      ancestryStep.indexOf("merge-base --is-ancestor"),
    );
    expect(ancestryStep).not.toMatch(/workflow_run|git -C \.|\.git\/config/);
  });

  it("performs one digest-pinned mutation and exact post-check with no repair path", () => {
    expect(mutationStep.match(/docker buildx imagetools create/g)).toHaveLength(
      1,
    );
    expect(mutationStep).toContain("--tag ghcr.io/felixgeisler/draw:edge");
    expect(mutationStep).toContain(
      '"ghcr.io/felixgeisler/draw:sha-$TARGET_SHA@sha256:$verified_digest"',
    );
    expect(mutationStep).not.toMatch(
      /workflow_run|:edge@|delete|rollback|retry|repair/i,
    );
    expect(postPromotionStep).toContain('--expected-revision "$TARGET_SHA"');
    expect(postPromotionStep).toContain('[[ "$digest" == "$SOURCE_DIGEST" ]]');
    expect(promotionJob.match(/docker buildx imagetools create/g)).toHaveLength(
      1,
    );
    expect(promotionJob).not.toMatch(
      /gh release|docker manifest (rm|push)|:latest|:dryrun/,
    );
  });
});

type EdgeEvidence =
  | { kind: "absent" }
  | { kind: "valid"; revision: string; digest: string }
  | { kind: "invalid" };
type PromotionOutcome = "source-missing" | "equal" | "promoted" | "blocked";

class PromotionModel {
  readonly parents = new Map<string, string | undefined>();
  readonly sources = new Map<string, string>();
  edge: EdgeEvidence = { kind: "absent" };
  readonly mutations: Array<{ target: string; digest: string }> = [];

  addCommit(
    revision: string,
    parent: string | undefined,
    sourceDigest?: string,
  ) {
    this.parents.set(revision, parent);
    if (sourceDigest !== undefined) this.sources.set(revision, sourceDigest);
  }

  private isAncestor(revision: string, target: string): boolean {
    const visited = new Set<string>();
    let cursor: string | undefined = target;
    while (cursor !== undefined && !visited.has(cursor)) {
      if (cursor === revision) return true;
      visited.add(cursor);
      cursor = this.parents.get(cursor);
    }
    return false;
  }

  run(
    target: string,
    post: "valid" | "mismatch" | "absent" | "failure" = "valid",
  ): PromotionOutcome {
    const sourceDigest = this.sources.get(target);
    if (sourceDigest === undefined) return "source-missing";
    if (this.edge.kind === "invalid") return "blocked";
    if (
      this.edge.kind === "valid" &&
      !this.isAncestor(this.edge.revision, target)
    ) {
      return "blocked";
    }
    if (this.edge.kind === "valid" && this.edge.digest === sourceDigest)
      return "equal";
    this.mutations.push({ target, digest: sourceDigest });
    if (post !== "valid") return "blocked";
    this.edge = { kind: "valid", revision: target, digest: sourceDigest };
    return "promoted";
  }
}

class PromotionConcurrency {
  running: string | undefined;
  pending: string | undefined;
  readonly replaced: string[] = [];

  arrive(id: string) {
    if (this.running === undefined) this.running = id;
    else {
      if (this.pending !== undefined) this.replaced.push(this.pending);
      this.pending = id;
    }
  }

  complete(): string | undefined {
    const completed = this.running;
    this.running = this.pending;
    this.pending = undefined;
    return completed;
  }
}

class HistoryLifecycleModel {
  area = false;
  handedOff = false;
  removed = false;

  initialize(failure: "none" | "before-area" | "after-area") {
    if (failure === "before-area") return;
    this.area = true;
    if (failure === "after-area") {
      this.area = false;
      this.removed = true;
      return;
    }
    this.handedOff = true;
  }

  finish(pathSafe = true) {
    if (!this.handedOff || !this.area || !pathSafe) return false;
    this.area = false;
    this.removed = true;
    return true;
  }
}

describe("isolated history lifecycle state model", () => {
  it("removes initialization state on failure before handoff", () => {
    const beforeArea = new HistoryLifecycleModel();
    beforeArea.initialize("before-area");
    expect(beforeArea).toMatchObject({
      area: false,
      handedOff: false,
      removed: false,
    });

    const afterArea = new HistoryLifecycleModel();
    afterArea.initialize("after-area");
    expect(afterArea).toMatchObject({
      area: false,
      handedOff: false,
      removed: true,
    });
  });

  it.each(["source no-op", "equal no-op", "later failure", "success"])(
    "retains history through %s and removes it in final cleanup",
    () => {
      const lifecycle = new HistoryLifecycleModel();
      lifecycle.initialize("none");
      expect(lifecycle).toMatchObject({
        area: true,
        handedOff: true,
        removed: false,
      });
      expect(lifecycle.finish()).toBe(true);
      expect(lifecycle).toMatchObject({
        area: false,
        handedOff: true,
        removed: true,
      });
    },
  );

  it("rejects absent, unhanded, or unsafe cleanup paths", () => {
    const absent = new HistoryLifecycleModel();
    expect(absent.finish()).toBe(false);
    const unsafe = new HistoryLifecycleModel();
    unsafe.initialize("none");
    expect(unsafe.finish(false)).toBe(false);
    expect(unsafe.area).toBe(true);
  });
});

describe("convergent promotion and global concurrency state model", () => {
  it("models one running and one replaceable pending arrival without cancellation", () => {
    const queue = new PromotionConcurrency();
    queue.arrive("run-a");
    queue.arrive("run-b");
    queue.arrive("run-c");
    expect(queue).toMatchObject({
      running: "run-a",
      pending: "run-c",
      replaced: ["run-b"],
    });
    expect(queue.complete()).toBe("run-a");
    expect(queue.running).toBe("run-c");
    expect(queue.complete()).toBe("run-c");
  });

  it("converges through reverse publication completion, reruns, and main advancement", () => {
    const model = new PromotionModel();
    const a = sha("a");
    const b = sha("b");
    const c = sha("c");
    model.addCommit(a, undefined, digest("1"));
    model.addCommit(b, a);
    model.addCommit(c, b);
    expect(model.run(c)).toBe("source-missing");
    expect(model.mutations).toEqual([]);
    model.addCommit(c, b, digest("3"));
    expect(model.run(c)).toBe("promoted");
    expect(model.run(c)).toBe("equal");
    const d = sha("d");
    model.addCommit(d, c, digest("4"));
    expect(model.run(d)).toBe("promoted");
    expect(model.edge).toEqual({
      kind: "valid",
      revision: d,
      digest: digest("4"),
    });
  });

  it("accepts missing/equal/older ancestry and never moves backward or from invalid evidence", () => {
    const model = new PromotionModel();
    const a = sha("a");
    const b = sha("b");
    const divergent = sha("e");
    model.addCommit(a, undefined, digest("1"));
    model.addCommit(b, a, digest("2"));
    model.addCommit(divergent, undefined, digest("e"));
    expect(model.run(a)).toBe("promoted");
    expect(model.run(b)).toBe("promoted");
    expect(model.run(a)).toBe("blocked");
    expect(model.run(divergent)).toBe("blocked");
    expect(model.mutations.map(({ target }) => target)).toEqual([a, b]);
    model.edge = { kind: "invalid" };
    expect(model.run(b)).toBe("blocked");
  });

  it.each(["mismatch", "absent", "failure"] as const)(
    "fails closed after post-check %s with exactly one mutation and no repair",
    (post) => {
      const model = new PromotionModel();
      model.addCommit(sha("a"), undefined, digest("1"));
      expect(model.run(sha("a"), post)).toBe("blocked");
      expect(model.mutations).toEqual([
        { target: sha("a"), digest: digest("1") },
      ]);
    },
  );

  it("fails closed for unprovable history and preserves edge", () => {
    const model = new PromotionModel();
    const target = sha("b");
    model.addCommit(target, undefined, digest("2"));
    model.edge = { kind: "valid", revision: sha("a"), digest: digest("1") };
    expect(model.run(target)).toBe("blocked");
    expect(model.mutations).toEqual([]);
    expect(model.edge).toEqual({
      kind: "valid",
      revision: sha("a"),
      digest: digest("1"),
    });
  });
});
