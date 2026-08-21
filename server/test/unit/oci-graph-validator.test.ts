import { describe, expect, it } from "vitest";
// The production contract is intentionally a plain Node ESM module.
// @ts-expect-error JavaScript module has no declaration file.
import { OciGraphValidationError, validateOciGraph } from "../../../scripts/lib/oci-graph-validator.mjs";
import {
  bytes,
  cloneFixture,
  CONFIG_MEDIA_TYPE,
  digest,
  INDEX_MEDIA_TYPE,
  makeFixture,
  MANIFEST_MEDIA_TYPE,
  REVISION,
} from "./oci-validator-fixtures.js";

function expectedPlan(record: Record<string, any>) {
  return [{
    stage: record.stage,
    endpoint: record.endpoint,
    platform: record.platform,
    digest: record.requestedDigest,
    mediaType: record.expectedMediaType,
    size: record.expectedSize,
  }];
}

function caught(call: unknown): OciGraphValidationError {
  try {
    validateOciGraph(call);
  } catch (error) {
    expect(error).toBeInstanceOf(OciGraphValidationError);
    expect((error as Error).name).toBe("OciGraphValidationError");
    return error as OciGraphValidationError;
  }
  throw new Error("expected validateOciGraph to fail");
}

function expectedCall(records: unknown[], revision = REVISION) {
  return { mode: "expected", expectedRevision: revision, records };
}

function deriveCall(records: unknown[]) {
  return { mode: "derive", records };
}

function replaceNamedBody(record: Record<string, any>, body: Uint8Array) {
  record.body = body;
  record.headers.dockerContentDigest = [digest(body)];
}

describe("validateOciGraph staged contract", () => {
  it("exports exactly the validator and typed error", async () => {
    // @ts-expect-error JavaScript module has no declaration file.
    const module = await import("../../../scripts/lib/oci-graph-validator.mjs");
    expect(Object.keys(module).sort()).toEqual(["OciGraphValidationError", "validateOciGraph"]);
    expect(Object.getPrototypeOf(OciGraphValidationError.prototype)).toBe(Error.prototype);
  });

  it.each([false, true])("accepts every contiguous prefix in canonical plan order (reverse descriptors: %s)", (reverseDescriptors) => {
    const fixture = makeFixture({ reverseDescriptors });
    for (let length = 1; length <= 6; length += 1) {
      const records = fixture.records.slice(0, length);
      const result = validateOciGraph(expectedCall(records));
      expect(result).toEqual({
        digest: fixture.digest,
        revision: fixture.revision,
        fetchPlan: length === 6 ? [] : expectedPlan(fixture.records[length]),
      });
      expect(Object.keys(result)).toEqual(["digest", "revision", "fetchPlan"]);
      if (result.fetchPlan.length) {
        expect(Object.keys(result.fetchPlan[0])).toEqual(["stage", "endpoint", "platform", "digest", "mediaType", "size"]);
      }
      expect(validateOciGraph(expectedCall(records))).toEqual(result);
    }
  });

  it("completes in expected and derive modes with the same digest-pinned revision", () => {
    const fixture = makeFixture();
    const expected = { digest: fixture.digest, revision: REVISION, fetchPlan: [] };
    expect(validateOciGraph(expectedCall(fixture.records))).toEqual(expected);
    expect(validateOciGraph(deriveCall(fixture.records))).toEqual(expected);
  });

  it("pins descriptor media types while configs require octet-stream response content", () => {
    const fixture = makeFixture();
    expect(fixture.records[3]).toMatchObject({
      endpoint: "blobs",
      expectedMediaType: CONFIG_MEDIA_TYPE,
      headers: { contentType: ["application/octet-stream"] },
    });
    expect(fixture.records[5]).toMatchObject({
      endpoint: "blobs",
      expectedMediaType: CONFIG_MEDIA_TYPE,
      headers: { contentType: ["application/octet-stream"] },
    });
    expect(validateOciGraph(expectedCall(fixture.records)).fetchPlan).toEqual([]);
  });

  it("rejects conditional call-shape violations, empty/sparse/overlong arrays, and extra array fields as input", () => {
    const fixture = makeFixture();
    const hole = [fixture.records[0], fixture.records[1]];
    delete hole[1];
    const extra = fixture.records.slice(0, 1) as any;
    extra.note = true;
    for (const call of [
      null,
      { mode: "other", records: [fixture.records[0]] },
      { mode: "expected", records: [fixture.records[0]] },
      { mode: "expected", expectedRevision: REVISION.toUpperCase(), records: [fixture.records[0]] },
      { mode: "derive", expectedRevision: undefined, records: [fixture.records[0]] },
      { mode: "derive", records: [], extra: true },
      { mode: "derive", records: [] },
      { mode: "derive", records: hole },
      { mode: "derive", records: [...fixture.records, fixture.records[5]] },
      { mode: "derive", records: extra },
    ]) {
      expect(caught(call)).toMatchObject({ code: "INPUT_INVALID", stage: "input" });
    }
  });

  it("requires exact dense record/header shapes and maps malformed records to the expected stage", () => {
    const fixture = makeFixture();
    const missingRecordField = cloneFixture(fixture.records[0]) as any;
    delete missingRecordField.status;
    expect(caught(deriveCall([missingRecordField]))).toMatchObject({ code: "INPUT_INVALID", stage: "named-index" });

    const extraHeaderField = cloneFixture(fixture.records[0]) as any;
    extraHeaderField.headers.raw = [];
    expect(caught(deriveCall([extraHeaderField]))).toMatchObject({ code: "INPUT_INVALID", stage: "named-index" });

    const sparseHeader = cloneFixture(fixture.records[0]) as any;
    sparseHeader.headers.contentType.length = 2;
    expect(caught(deriveCall([sparseHeader]))).toMatchObject({ code: "INPUT_INVALID", stage: "named-index" });

    const wrongStageTypes = cloneFixture(fixture.records.slice(0, 3));
    wrongStageTypes[2].requestedDigest = null;
    wrongStageTypes[2].expectedSize = null;
    expect(caught(expectedCall(wrongStageTypes))).toMatchObject({ code: "INPUT_INVALID", stage: "amd64-manifest" });

    expect(caught(deriveCall([{ endpoint: "manifests" }]))).toMatchObject({ code: "INPUT_INVALID", stage: "input" });
  });

  it("rejects skipped, repeated, and out-of-order stages as STAGE_ORDER on the supplied valid stage", () => {
    const fixture = makeFixture();
    for (const records of [
      [fixture.records[1]],
      [fixture.records[0], fixture.records[0]],
      [fixture.records[0], fixture.records[2]],
      [fixture.records[0], fixture.records[1], fixture.records[3]],
    ]) {
      const error = caught(deriveCall(records));
      expect(error.code).toBe("STAGE_ORDER");
      expect(error.stage).toBe(records[records.length - 1].stage);
    }
  });

  it("uses own properties only while tolerating polluted prototypes on valid call, records, and headers", () => {
    const fixture = makeFixture();
    const record = cloneFixture(fixture.records[0]);
    Object.setPrototypeOf(record, { status: 500, endpoint: "blobs", extra: true });
    Object.setPrototypeOf(record.headers, { contentType: ["text/plain"], extra: true });
    const call = Object.assign(Object.create({ mode: "other", expectedRevision: "bad", extra: true }), deriveCall([record]));
    expect(validateOciGraph(call)).toEqual({
      digest: fixture.digest,
      revision: fixture.revision,
      fetchPlan: expectedPlan(fixture.records[1]),
    });

    const inheritedMode = Object.assign(Object.create({ mode: "derive" }), { records: [record] });
    expect(caught(inheritedMode)).toMatchObject({ code: "INPUT_INVALID", stage: "input" });
    const inheritedEndpoint = cloneFixture(record) as any;
    delete inheritedEndpoint.endpoint;
    Object.setPrototypeOf(inheritedEndpoint, { endpoint: "manifests" });
    expect(caught(deriveCall([inheritedEndpoint]))).toMatchObject({ code: "INPUT_INVALID", stage: "named-index" });
  });

  it("checks every authorization field before response evidence", () => {
    const fixture = makeFixture();
    const mutations: Array<(record: Record<string, any>) => void> = [
      (record) => { record.endpoint = "blobs"; },
      (record) => { record.platform = "linux/arm64"; },
      (record) => { record.requestedDigest = `sha256:${"f".repeat(64)}`; },
      (record) => { record.expectedMediaType = INDEX_MEDIA_TYPE; },
      (record) => { record.expectedSize += 1; },
    ];
    for (const mutate of mutations) {
      const record = cloneFixture(fixture.records[2]);
      mutate(record);
      record.status = 503;
      record.headers.contentType = ["text/plain"];
      expect(caught(expectedCall([fixture.records[0], fixture.records[1], record]))).toMatchObject({
        code: "PLAN_MISMATCH",
        stage: "amd64-manifest",
      });
    }
  });

  it("maps every graph error code and preserves the earliest record/phase precedence", () => {
    const fixture = makeFixture();

    const badPlan = cloneFixture(fixture.records[0]);
    badPlan.endpoint = "blobs";
    expect(caught(deriveCall([badPlan]))).toMatchObject({ code: "PLAN_MISMATCH", stage: "named-index" });

    const badStatus = cloneFixture(fixture.records[0]);
    badStatus.status = 404;
    badStatus.headers.contentType = [];
    expect(caught(deriveCall([badStatus]))).toMatchObject({ code: "HTTP_STATUS", stage: "named-index" });

    const badHeader = cloneFixture(fixture.records[0]);
    badHeader.headers.contentType = [`${INDEX_MEDIA_TYPE}; charset=utf-8`];
    expect(caught(deriveCall([badHeader]))).toMatchObject({ code: "HEADER_INVALID", stage: "named-index" });

    const badSizeRecords = cloneFixture(fixture.records.slice(0, 3));
    badSizeRecords[2].body = new Uint8Array([...badSizeRecords[2].body, 0x20]);
    expect(caught(expectedCall(badSizeRecords))).toMatchObject({ code: "BODY_SIZE", stage: "amd64-manifest" });

    const badDigest = cloneFixture(fixture.records[0]);
    badDigest.body[0] ^= 1;
    expect(caught(deriveCall([badDigest]))).toMatchObject({ code: "DIGEST_MISMATCH", stage: "named-index" });

    const badJson = cloneFixture(fixture.records[0]);
    replaceNamedBody(badJson, bytes('{"a":1,"a":2}'));
    expect(caught(deriveCall([badJson]))).toMatchObject({ code: "JSON_INVALID", stage: "named-index" });

    const badSchema = cloneFixture(fixture.records[0]);
    replaceNamedBody(badSchema, bytes({ schemaVersion: 1 }));
    expect(caught(deriveCall([badSchema]))).toMatchObject({ code: "SCHEMA_INVALID", stage: "named-index" });

    expect(caught(expectedCall([fixture.records[0]], "f".repeat(40)))).toMatchObject({
      code: "REVISION_MISMATCH",
      stage: "named-index",
    });
  });

  it("enforces status, encoding, content type, digest-header cardinality/syntax, and optional agreement", () => {
    const fixture = makeFixture();
    const mutations: Array<[number, (record: any) => void, string]> = [
      [0, (r) => { r.headers.dockerContentDigest = []; }, "HEADER_INVALID"],
      [0, (r) => { r.headers.contentEncoding = ["gzip"]; }, "HEADER_INVALID"],
      [1, (r) => { r.headers.contentEncoding = ["identity"]; r.headers.dockerContentDigest = [r.requestedDigest]; }, "ok"],
      [1, (r) => { r.headers.dockerContentDigest = ["SHA256:" + "a".repeat(64)]; }, "HEADER_INVALID"],
      [2, (r) => { r.headers.dockerContentDigest = ["sha256:" + "0".repeat(64)]; }, "DIGEST_MISMATCH"],
      [3, (r) => { r.headers.contentType = [CONFIG_MEDIA_TYPE]; }, "HEADER_INVALID"],
    ];
    for (const [at, mutate, code] of mutations) {
      const records = cloneFixture(fixture.records.slice(0, at + 1));
      mutate(records[at]);
      if (code === "ok") expect(validateOciGraph(expectedCall(records))).toBeTruthy();
      else expect(caught(expectedCall(records)).code).toBe(code);
    }
  });

  it("does not authorize a manifest until both independently validated index responses succeed", () => {
    const fixture = makeFixture();
    const one = validateOciGraph(expectedCall(fixture.records.slice(0, 1)));
    expect(one.fetchPlan).toEqual(expectedPlan(fixture.records[1]));

    const badPinned = cloneFixture(fixture.records.slice(0, 2));
    badPinned[1].body = new Uint8Array(badPinned[1].body);
    badPinned[1].body[badPinned[1].body.length - 1] ^= 1;
    expect(caught(expectedCall(badPinned))).toMatchObject({ code: "DIGEST_MISMATCH", stage: "digest-index" });
  });
});

describe("OCI index, descriptor, manifest, and config schemas", () => {
  it("rejects malformed index versions, annotations, platform fields, duplicate digests, and forbidden known fields", () => {
    const mutations: Array<(index: Record<string, any>) => void> = [
      (x) => { x.schemaVersion = 2.0 + 0.5; },
      (x) => { delete x.annotations; },
      (x) => { x.annotations.extra = 1; },
      (x) => { x.annotations["org.opencontainers.image.revision"] = "ABC"; },
      (x) => { x.manifests[0].platform.variant = "v8"; },
      (x) => { x.manifests[0].platform["os.features"] = []; },
      (x) => { x.manifests[1].digest = x.manifests[0].digest; },
      (x) => { x.manifests[0].urls = []; },
      (x) => { x.manifests[0].size = Number.MAX_SAFE_INTEGER + 1; },
      (x) => { x.subject = {}; },
    ];
    for (const mutateIndex of mutations) {
      const fixture = makeFixture({ mutateIndex });
      expect(caught(deriveCall([fixture.records[0]]))).toMatchObject({ code: "SCHEMA_INVALID", stage: "named-index" });
    }
  });

  it("ignores unknown extensions only when required known fields remain valid", () => {
    const valid = makeFixture({ mutateIndex: (index) => {
      index["x-extension"] = { mediaType: "ignored" };
      index.manifests[0]["x-extension"] = true;
      index.manifests[0].platform["x-extension"] = "kept opaque";
    } });
    expect(validateOciGraph(deriveCall([valid.records[0]])).fetchPlan).toEqual(expectedPlan(valid.records[1]));

    const invalid = makeFixture({ mutateIndex: (index) => {
      delete index.mediaType;
      index["x-extension"] = { mediaType: INDEX_MEDIA_TYPE };
    } });
    expect(caught(deriveCall([invalid.records[0]])).code).toBe("SCHEMA_INVALID");
  });

  it("accepts exactly the three unfetched OCI layer media types", () => {
    for (const layerMediaType of [
      "application/vnd.oci.image.layer.v1.tar",
      "application/vnd.oci.image.layer.v1.tar+gzip",
      "application/vnd.oci.image.layer.v1.tar+zstd",
    ]) {
      const fixture = makeFixture({ mutateAmd64Manifest: (manifest) => {
        manifest.layers[0].mediaType = layerMediaType;
      } });
      expect(validateOciGraph(expectedCall(fixture.records.slice(0, 3))).fetchPlan).toEqual(expectedPlan(fixture.records[3]));
    }
  });

  it("enforces manifest schema, config descriptor policy, and nonempty valid but unfetched layers", () => {
    const mutations: Array<(manifest: Record<string, any>) => void> = [
      (x) => { x.mediaType = INDEX_MEDIA_TYPE; },
      (x) => { x.layers = []; },
      (x) => { x.layers[0].mediaType = "application/example"; },
      (x) => { x.layers[0].platform = { os: "linux", architecture: "amd64" }; },
      (x) => { x.layers[0].data = "embedded"; },
      (x) => { x.config.mediaType = "application/octet-stream"; },
      (x) => { x.config.annotations = { invalid: 1 }; },
      (x) => { x.artifactType = "application/example"; },
    ];
    for (const mutateAmd64Manifest of mutations) {
      const fixture = makeFixture({ mutateAmd64Manifest });
      expect(caught(expectedCall(fixture.records.slice(0, 3)))).toMatchObject({
        code: "SCHEMA_INVALID",
        stage: "amd64-manifest",
      });
    }
  });

  it("enforces config parent platform, object labels, string values, and revision matching in both modes", () => {
    const malformed: Array<(config: Record<string, any>) => void> = [
      (x) => { x.architecture = "arm64"; },
      (x) => { x.config = []; },
      (x) => { x.config.Labels.extra = 1; },
      (x) => { delete x.config.Labels["org.opencontainers.image.revision"]; },
    ];
    for (const mutateAmd64Config of malformed) {
      const fixture = makeFixture({ mutateAmd64Config });
      expect(caught(expectedCall(fixture.records.slice(0, 4)))).toMatchObject({
        code: "SCHEMA_INVALID",
        stage: "amd64-config",
      });
    }

    const amdMismatch = makeFixture({ amd64ConfigRevision: "f".repeat(40) });
    expect(caught(deriveCall(amdMismatch.records.slice(0, 4)))).toMatchObject({
      code: "REVISION_MISMATCH",
      stage: "amd64-config",
    });
    const armMismatch = makeFixture({ arm64ConfigRevision: "f".repeat(40) });
    expect(caught(expectedCall(armMismatch.records))).toMatchObject({
      code: "REVISION_MISMATCH",
      stage: "arm64-config",
    });
  });

  it("parses schema objects with null prototypes and preserves dangerous own extension names without pollution", () => {
    const before = Object.getOwnPropertyDescriptors(Object.prototype);
    const fixture = makeFixture({ mutateIndex: (index) => {
      Object.defineProperty(index, "__proto__", { value: { schemaVersion: 999 }, enumerable: true });
      index["constructor"] = "ordinary extension";
      index["prototype"] = { mediaType: "ordinary extension" };
    } });
    expect(validateOciGraph(deriveCall([fixture.records[0]])).revision).toBe(REVISION);
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(before);
  });
});

describe("pure bounded-byte core", () => {
  it("production modules use only Node built-ins and the strict parser, with no transport/process globals", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const root = path.resolve(import.meta.dirname, "../../..");
    const sources = await Promise.all([
      fs.readFile(path.join(root, "scripts/lib/strict-json.mjs"), "utf8"),
      fs.readFile(path.join(root, "scripts/lib/oci-graph-validator.mjs"), "utf8"),
    ]);
    const joined = sources.join("\n");
    expect(joined).not.toMatch(/(?:\bfetch\s*\(|\bchild_process\b|\bsetTimeout\b|\bsetInterval\b|\bAbortSignal\b|\bprocess\.env\b|\bzlib\b)/);
    expect(joined).not.toMatch(/1\s*\*\s*1024\s*\*\s*1024|1048576/);
    expect(joined.match(/^import .* from .*;$/gm) ?? []).toEqual([
      'import { createHash } from "node:crypto";',
      'import { parseStrictJson, StrictJsonError } from "./strict-json.mjs";',
    ]);
  });
});
