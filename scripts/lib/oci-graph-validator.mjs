import { createHash } from "node:crypto";
import { parseStrictJson, StrictJsonError } from "./strict-json.mjs";

export class OciGraphValidationError extends Error {
  constructor(code, stage, message) {
    super(message);
    this.name = "OciGraphValidationError";
    this.code = code;
    this.stage = stage;
  }
}

const INDEX_MEDIA_TYPE = "application/vnd.oci.image.index.v1+json";
const MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";
const CONFIG_MEDIA_TYPE = "application/vnd.oci.image.config.v1+json";
const OCTET_STREAM = "application/octet-stream";

function makeSet(...values) {
  const result = new Set();
  for (let index = 0; index < values.length; index += 1) result.add(values[index]);
  return result;
}

const LAYER_MEDIA_TYPES = makeSet(
  "application/vnd.oci.image.layer.v1.tar",
  "application/vnd.oci.image.layer.v1.tar+gzip",
  "application/vnd.oci.image.layer.v1.tar+zstd",
);
const DESCRIPTOR_MEDIA_TYPES = makeSet(INDEX_MEDIA_TYPE, MANIFEST_MEDIA_TYPE, CONFIG_MEDIA_TYPE);
const MANIFEST_DESCRIPTOR_MEDIA_TYPES = makeSet(MANIFEST_MEDIA_TYPE);
const CONFIG_DESCRIPTOR_MEDIA_TYPES = makeSet(CONFIG_MEDIA_TYPE);
const STAGES = [
  "named-index",
  "digest-index",
  "amd64-manifest",
  "amd64-config",
  "arm64-manifest",
  "arm64-config",
];
const STAGE_SET = makeSet(
  "named-index",
  "digest-index",
  "amd64-manifest",
  "amd64-config",
  "arm64-manifest",
  "arm64-config",
);
const ENDPOINTS = makeSet("manifests", "blobs");
const PLATFORMS = makeSet(null, "linux/amd64", "linux/arm64");
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;
const CALL_KEYS_EXPECTED = ["mode", "expectedRevision", "records"];
const CALL_KEYS_DERIVE = ["mode", "records"];
const RECORD_KEYS = [
  "stage",
  "endpoint",
  "platform",
  "requestedDigest",
  "expectedMediaType",
  "expectedSize",
  "status",
  "headers",
  "body",
];
const HEADER_KEYS = ["contentType", "contentEncoding", "dockerContentDigest"];

function graphError(code, stage, message) {
  throw new OciGraphValidationError(code, stage, message);
}

function has(value, key) {
  return Object.hasOwn(value, key);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactOwnKeys(value, expected) {
  if (!isObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && expected.every((key) => has(value, key));
}

function inspectOwnData(value) {
  if (!isObject(value) && !Array.isArray(value)) return null;
  const keys = Reflect.ownKeys(value);
  const values = Object.create(null);
  let dataOnly = true;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !has(descriptor, "value")) {
      dataOnly = false;
      continue;
    }
    Object.defineProperty(values, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return { keys, values, dataOnly };
}

function hasExactInspectedKeys(inspection, expected) {
  return inspection !== null && inspection.dataOnly &&
    inspection.keys.length === expected.length && expected.every((key) => has(inspection.values, key));
}

function snapshotDenseArray(value, { strings = false } = {}) {
  if (!Array.isArray(value)) return null;
  const inspection = inspectOwnData(value);
  if (inspection === null || !inspection.dataOnly) return null;
  const length = inspection.values.length;
  if (!Number.isSafeInteger(length) || length < 0 || inspection.keys.length !== length + 1 || !inspection.keys.includes("length")) {
    return null;
  }
  const snapshot = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!has(inspection.values, key) || (strings && typeof inspection.values[key] !== "string")) return null;
    snapshot.push(inspection.values[key]);
  }
  return Object.freeze(snapshot);
}

function read(value, key) {
  return has(value, key) ? value[key] : undefined;
}

function isSafeSize(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateCall(call) {
  const inspection = inspectOwnData(call);
  const mode = inspection?.values.mode;
  if (mode !== "expected" && mode !== "derive") {
    graphError("INPUT_INVALID", "input", "mode must be an own data property equal to expected or derive");
  }
  const keys = mode === "expected" ? CALL_KEYS_EXPECTED : CALL_KEYS_DERIVE;
  if (!hasExactInspectedKeys(inspection, keys)) {
    graphError("INPUT_INVALID", "input", "call has an invalid shape or accessor for its mode");
  }
  const expectedRevision = mode === "expected" ? inspection.values.expectedRevision : null;
  if (mode === "expected" && (typeof expectedRevision !== "string" || !REVISION.test(expectedRevision))) {
    graphError("INPUT_INVALID", "input", "expectedRevision must be lowercase 40-hex");
  }
  const records = snapshotDenseArray(inspection.values.records);
  if (records === null || records.length < 1 || records.length > STAGES.length) {
    graphError("INPUT_INVALID", "input", "records must be a dense nonempty stage prefix without accessors");
  }
  return { mode, expectedRevision, records };
}

function snapshotRecordInput(inspection, stage, failureStage) {
  if (!hasExactInspectedKeys(inspection, RECORD_KEYS)) {
    graphError("INPUT_INVALID", failureStage, "record must have exact own data properties and no accessors");
  }
  const record = inspection.values;
  if (!ENDPOINTS.has(record.endpoint) || !PLATFORMS.has(record.platform)) {
    graphError("INPUT_INVALID", failureStage, "record endpoint or platform is invalid");
  }
  const digestShapeValid = stage === "named-index"
    ? record.requestedDigest === null
    : typeof record.requestedDigest === "string" && SHA256.test(record.requestedDigest);
  if (!digestShapeValid) {
    graphError("INPUT_INVALID", failureStage, "requestedDigest has the wrong shape for this stage");
  }
  if (!DESCRIPTOR_MEDIA_TYPES.has(record.expectedMediaType)) {
    graphError("INPUT_INVALID", failureStage, "expectedMediaType is not an authorized descriptor media type");
  }
  const sizeShapeValid = stage.endsWith("-index") ? record.expectedSize === null : isSafeSize(record.expectedSize);
  if (!sizeShapeValid) {
    graphError("INPUT_INVALID", failureStage, "expectedSize has the wrong shape for this stage");
  }
  if (!Number.isInteger(record.status)) {
    graphError("INPUT_INVALID", failureStage, "status must be an integer");
  }

  const headerInspection = inspectOwnData(record.headers);
  if (!hasExactInspectedKeys(headerInspection, HEADER_KEYS)) {
    graphError("INPUT_INVALID", failureStage, "headers must have exact own data properties and no accessors");
  }
  const headers = Object.create(null);
  for (let index = 0; index < HEADER_KEYS.length; index += 1) {
    const key = HEADER_KEYS[index];
    const values = snapshotDenseArray(headerInspection.values[key], { strings: true });
    if (values === null) graphError("INPUT_INVALID", failureStage, `${key} must be a dense data-only string array`);
    headers[key] = values;
  }
  Object.freeze(headers);

  if (!(record.body instanceof Uint8Array)) {
    graphError("INPUT_INVALID", failureStage, "body must be a Uint8Array");
  }
  const snapshot = Object.create(null);
  for (let index = 0; index < RECORD_KEYS.length; index += 1) {
    const key = RECORD_KEYS[index];
    snapshot[key] = record[key];
  }
  snapshot.headers = headers;
  snapshot.body = new Uint8Array(record.body);
  return Object.freeze(snapshot);
}

function makePlan(stage, endpoint, platform, digest, mediaType, size) {
  return { stage, endpoint, platform, digest, mediaType, size };
}

function validateAuthorization(record, expected, stage) {
  if (
    read(record, "endpoint") !== expected.endpoint ||
    read(record, "platform") !== expected.platform ||
    read(record, "requestedDigest") !== expected.digest ||
    read(record, "expectedMediaType") !== expected.mediaType ||
    read(record, "expectedSize") !== expected.size
  ) {
    graphError("PLAN_MISMATCH", stage, "record metadata does not match the authorized fetch plan");
  }
}

function validateHeaders(record, stage) {
  const headers = read(record, "headers");
  const contentType = read(headers, "contentType");
  const contentEncoding = read(headers, "contentEncoding");
  const dockerDigest = read(headers, "dockerContentDigest");
  const expectedContentType = stage.endsWith("-config") ? OCTET_STREAM : read(record, "expectedMediaType");

  if (contentType.length !== 1 || contentType[0] !== expectedContentType) {
    graphError("HEADER_INVALID", stage, "Content-Type must be one exact parameter-free value");
  }
  if (contentEncoding.length > 1 || (contentEncoding.length === 1 && contentEncoding[0] !== "identity")) {
    graphError("HEADER_INVALID", stage, "Content-Encoding must be absent or exactly identity");
  }
  const requiredDigest = stage === "named-index";
  if ((requiredDigest && dockerDigest.length !== 1) || (!requiredDigest && dockerDigest.length > 1)) {
    graphError("HEADER_INVALID", stage, "Docker-Content-Digest cardinality is invalid");
  }
  if (dockerDigest.length === 1 && !SHA256.test(dockerDigest[0])) {
    graphError("HEADER_INVALID", stage, "Docker-Content-Digest syntax is invalid");
  }
}

function digestBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function bytesEqual(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function validateBodyEvidence(record, stage, namedBody) {
  const body = read(record, "body");
  if ((stage.endsWith("-manifest") || stage.endsWith("-config")) && body.length !== read(record, "expectedSize")) {
    graphError("BODY_SIZE", stage, "body length does not match the authorized descriptor size");
  }

  const actualDigest = digestBytes(body);
  const headerDigests = read(read(record, "headers"), "dockerContentDigest");
  if (stage === "named-index") {
    if (headerDigests[0] !== actualDigest) {
      graphError("DIGEST_MISMATCH", stage, "named index body does not match Docker-Content-Digest");
    }
  } else {
    if (read(record, "requestedDigest") !== actualDigest) {
      graphError("DIGEST_MISMATCH", stage, "body does not match the requested digest");
    }
    if (headerDigests.length === 1 && headerDigests[0] !== actualDigest) {
      graphError("DIGEST_MISMATCH", stage, "Docker-Content-Digest disagrees with the requested body digest");
    }
  }
  if (stage === "digest-index" && !bytesEqual(body, namedBody)) {
    graphError("DIGEST_MISMATCH", stage, "digest-pinned index bytes differ from the named index");
  }
  return actualDigest;
}

function parseBody(body, stage) {
  try {
    return parseStrictJson(body);
  } catch (error) {
    if (error instanceof StrictJsonError) {
      graphError("JSON_INVALID", stage, "response body is not strict JSON");
    }
    throw error;
  }
}

function schemaFailure(stage, message) {
  graphError("SCHEMA_INVALID", stage, message);
}

function requireObject(value, stage, description) {
  if (!isObject(value)) schemaFailure(stage, `${description} must be an object`);
  return value;
}

function requireOwn(value, key, stage, description) {
  if (!has(value, key)) schemaFailure(stage, `${description} requires ${key}`);
  return read(value, key);
}

function validateStringMap(value, stage, description) {
  requireObject(value, stage, description);
  const keys = Reflect.ownKeys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== "string" || typeof read(value, key) !== "string") {
      schemaFailure(stage, `${description} values must be strings`);
    }
  }
}

function validateOptionalAnnotations(value, stage, description) {
  if (has(value, "annotations")) validateStringMap(read(value, "annotations"), stage, `${description}.annotations`);
}

function validateDescriptor(value, stage, { mediaTypes, platform }) {
  requireObject(value, stage, "descriptor");
  const mediaType = requireOwn(value, "mediaType", stage, "descriptor");
  const digest = requireOwn(value, "digest", stage, "descriptor");
  const size = requireOwn(value, "size", stage, "descriptor");
  if (typeof mediaType !== "string" || !mediaTypes.has(mediaType)) schemaFailure(stage, "descriptor mediaType is invalid");
  if (typeof digest !== "string" || !SHA256.test(digest)) schemaFailure(stage, "descriptor digest is invalid");
  if (!isSafeSize(size)) schemaFailure(stage, "descriptor size is invalid");
  const forbiddenDescriptorKeys = ["urls", "data", "artifactType"];
  for (let index = 0; index < forbiddenDescriptorKeys.length; index += 1) {
    const forbidden = forbiddenDescriptorKeys[index];
    if (has(value, forbidden)) schemaFailure(stage, `descriptor ${forbidden} is forbidden`);
  }
  validateOptionalAnnotations(value, stage, "descriptor");

  let platformName = null;
  if (platform === "required") {
    const platformValue = requireOwn(value, "platform", stage, "descriptor");
    requireObject(platformValue, stage, "descriptor.platform");
    const os = requireOwn(platformValue, "os", stage, "descriptor.platform");
    const architecture = requireOwn(platformValue, "architecture", stage, "descriptor.platform");
    if (os !== "linux" || (architecture !== "amd64" && architecture !== "arm64")) {
      schemaFailure(stage, "descriptor platform must be exactly linux/amd64 or linux/arm64");
    }
    const forbiddenPlatformKeys = ["variant", "os.version", "os.features"];
    for (let index = 0; index < forbiddenPlatformKeys.length; index += 1) {
      const forbidden = forbiddenPlatformKeys[index];
      if (has(platformValue, forbidden)) schemaFailure(stage, `descriptor platform ${forbidden} is forbidden`);
    }
    platformName = `linux/${architecture}`;
  } else if (has(value, "platform")) {
    schemaFailure(stage, "descriptor platform is forbidden here");
  }

  return { mediaType, digest, size, platform: platformName };
}

function validateIndex(value, stage) {
  requireObject(value, stage, "index");
  if (requireOwn(value, "schemaVersion", stage, "index") !== 2) schemaFailure(stage, "index schemaVersion must be integer 2");
  if (requireOwn(value, "mediaType", stage, "index") !== INDEX_MEDIA_TYPE) schemaFailure(stage, "index mediaType is invalid");
  if (has(value, "subject") || has(value, "artifactType")) schemaFailure(stage, "index subject and artifactType are forbidden");

  const annotations = requireOwn(value, "annotations", stage, "index");
  validateStringMap(annotations, stage, "index.annotations");
  const revision = requireOwn(annotations, "org.opencontainers.image.revision", stage, "index.annotations");
  if (typeof revision !== "string" || !REVISION.test(revision)) schemaFailure(stage, "index revision annotation is invalid");

  const manifests = snapshotDenseArray(requireOwn(value, "manifests", stage, "index"));
  if (manifests === null || manifests.length !== 2) schemaFailure(stage, "index must contain exactly two own descriptors");
  const byPlatform = new Map();
  for (let index = 0; index < manifests.length; index += 1) {
    const descriptor = validateDescriptor(manifests[index], stage, {
      mediaTypes: MANIFEST_DESCRIPTOR_MEDIA_TYPES,
      platform: "required",
    });
    if (byPlatform.has(descriptor.platform)) schemaFailure(stage, "index platforms must be unique");
    byPlatform.set(descriptor.platform, descriptor);
  }
  if (!byPlatform.has("linux/amd64") || !byPlatform.has("linux/arm64")) {
    schemaFailure(stage, "index must contain amd64 and arm64 descriptors");
  }
  if (byPlatform.get("linux/amd64").digest === byPlatform.get("linux/arm64").digest) {
    schemaFailure(stage, "index child digests must be distinct");
  }
  return { revision, byPlatform };
}

function validateManifest(value, stage) {
  requireObject(value, stage, "manifest");
  if (requireOwn(value, "schemaVersion", stage, "manifest") !== 2) schemaFailure(stage, "manifest schemaVersion must be integer 2");
  if (requireOwn(value, "mediaType", stage, "manifest") !== MANIFEST_MEDIA_TYPE) schemaFailure(stage, "manifest mediaType is invalid");
  if (has(value, "subject") || has(value, "artifactType")) schemaFailure(stage, "manifest subject and artifactType are forbidden");
  validateOptionalAnnotations(value, stage, "manifest");

  const config = validateDescriptor(requireOwn(value, "config", stage, "manifest"), stage, {
    mediaTypes: CONFIG_DESCRIPTOR_MEDIA_TYPES,
    platform: "forbidden",
  });
  const layers = snapshotDenseArray(requireOwn(value, "layers", stage, "manifest"));
  if (layers === null || layers.length === 0) schemaFailure(stage, "manifest layers must be a nonempty own array");
  for (let index = 0; index < layers.length; index += 1) {
    validateDescriptor(layers[index], stage, { mediaTypes: LAYER_MEDIA_TYPES, platform: "forbidden" });
  }
  return { config };
}

function validateConfig(value, stage, platform) {
  requireObject(value, stage, "config body");
  validateOptionalAnnotations(value, stage, "config body");
  const platformParts = platform.split("/");
  const os = platformParts[0];
  const architecture = platformParts[1];
  if (requireOwn(value, "os", stage, "config body") !== os || requireOwn(value, "architecture", stage, "config body") !== architecture) {
    schemaFailure(stage, "config body platform does not match its parent");
  }
  const config = requireOwn(value, "config", stage, "config body");
  requireObject(config, stage, "config body.config");
  const labels = requireOwn(config, "Labels", stage, "config body.config");
  validateStringMap(labels, stage, "config body.config.Labels");
  const revision = requireOwn(labels, "org.opencontainers.image.revision", stage, "config body.config.Labels");
  if (typeof revision !== "string") schemaFailure(stage, "config revision label must be a string");
  return { revision };
}

function manifestPlan(stage, platform, descriptor) {
  return makePlan(stage, "manifests", platform, descriptor.digest, descriptor.mediaType, descriptor.size);
}

function configPlan(stage, platform, descriptor) {
  return makePlan(stage, "blobs", platform, descriptor.digest, descriptor.mediaType, descriptor.size);
}

export function validateOciGraph(call) {
  const { mode, expectedRevision, records } = validateCall(call);
  let expectedPlan = makePlan("named-index", "manifests", null, null, INDEX_MEDIA_TYPE, null);
  let namedDigest = null;
  let namedBody = null;
  let revision = null;
  let indexDescriptors = null;

  for (let index = 0; index < records.length; index += 1) {
    const inspection = inspectOwnData(records[index]);
    const expectedStage = STAGES[index];
    const suppliedStage = inspection?.values.stage;
    if (!STAGE_SET.has(suppliedStage)) {
      graphError("INPUT_INVALID", "input", "record stage is missing, invalid, or an accessor");
    }

    const failureStage = suppliedStage === expectedStage ? expectedStage : "input";
    const record = snapshotRecordInput(inspection, suppliedStage, failureStage);
    if (suppliedStage !== expectedStage) {
      graphError("STAGE_ORDER", suppliedStage, "record stage is not the next canonical stage");
    }

    validateAuthorization(record, expectedPlan, expectedStage);
    if (read(record, "status") !== 200) graphError("HTTP_STATUS", expectedStage, "response status must be 200");
    validateHeaders(record, expectedStage);
    const actualDigest = validateBodyEvidence(record, expectedStage, namedBody);
    const body = parseBody(read(record, "body"), expectedStage);

    if (expectedStage === "named-index") {
      const validated = validateIndex(body, expectedStage);
      if (mode === "expected" && expectedRevision !== validated.revision) {
        graphError("REVISION_MISMATCH", expectedStage, "index revision does not match expectedRevision");
      }
      namedDigest = actualDigest;
      namedBody = read(record, "body");
      revision = validated.revision;
      expectedPlan = makePlan("digest-index", "manifests", null, namedDigest, INDEX_MEDIA_TYPE, null);
    } else if (expectedStage === "digest-index") {
      const validated = validateIndex(body, expectedStage);
      if (mode === "expected" && expectedRevision !== validated.revision) {
        graphError("REVISION_MISMATCH", expectedStage, "index revision does not match expectedRevision");
      }
      indexDescriptors = validated.byPlatform;
      expectedPlan = manifestPlan("amd64-manifest", "linux/amd64", indexDescriptors.get("linux/amd64"));
    } else if (expectedStage === "amd64-manifest") {
      const validated = validateManifest(body, expectedStage);
      expectedPlan = configPlan("amd64-config", "linux/amd64", validated.config);
    } else if (expectedStage === "amd64-config") {
      const validated = validateConfig(body, expectedStage, "linux/amd64");
      if (validated.revision !== revision) graphError("REVISION_MISMATCH", expectedStage, "config revision does not match index revision");
      expectedPlan = manifestPlan("arm64-manifest", "linux/arm64", indexDescriptors.get("linux/arm64"));
    } else if (expectedStage === "arm64-manifest") {
      const validated = validateManifest(body, expectedStage);
      expectedPlan = configPlan("arm64-config", "linux/arm64", validated.config);
    } else {
      const validated = validateConfig(body, expectedStage, "linux/arm64");
      if (validated.revision !== revision) graphError("REVISION_MISMATCH", expectedStage, "config revision does not match index revision");
      expectedPlan = null;
    }
  }

  return {
    digest: namedDigest,
    revision,
    fetchPlan: expectedPlan === null ? [] : [expectedPlan],
  };
}
