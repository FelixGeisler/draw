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
const LAYER_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.layer.v1.tar",
  "application/vnd.oci.image.layer.v1.tar+gzip",
  "application/vnd.oci.image.layer.v1.tar+zstd",
]);
const DESCRIPTOR_MEDIA_TYPES = new Set([INDEX_MEDIA_TYPE, MANIFEST_MEDIA_TYPE, CONFIG_MEDIA_TYPE]);
const STAGES = [
  "named-index",
  "digest-index",
  "amd64-manifest",
  "amd64-config",
  "arm64-manifest",
  "arm64-config",
];
const STAGE_SET = new Set(STAGES);
const ENDPOINTS = new Set(["manifests", "blobs"]);
const PLATFORMS = new Set([null, "linux/amd64", "linux/arm64"]);
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

function isDenseArray(value, { strings = false } = {}) {
  if (!Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!has(value, String(index))) return false;
    if (strings && typeof value[index] !== "string") return false;
  }
  return true;
}

function read(value, key) {
  return has(value, key) ? value[key] : undefined;
}

function isSafeSize(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateCall(call) {
  if (!isObject(call) || !has(call, "mode")) {
    graphError("INPUT_INVALID", "input", "call must be an exact object with an own mode");
  }
  const mode = read(call, "mode");
  if (mode !== "expected" && mode !== "derive") {
    graphError("INPUT_INVALID", "input", "mode must be expected or derive");
  }
  const keys = mode === "expected" ? CALL_KEYS_EXPECTED : CALL_KEYS_DERIVE;
  if (!hasExactOwnKeys(call, keys)) {
    graphError("INPUT_INVALID", "input", "call has an invalid shape for its mode");
  }
  if (mode === "expected" && (typeof read(call, "expectedRevision") !== "string" || !REVISION.test(read(call, "expectedRevision")))) {
    graphError("INPUT_INVALID", "input", "expectedRevision must be lowercase 40-hex");
  }
  const records = read(call, "records");
  if (!isDenseArray(records) || records.length < 1 || records.length > STAGES.length) {
    graphError("INPUT_INVALID", "input", "records must be a dense nonempty stage prefix");
  }
  return { mode, expectedRevision: mode === "expected" ? read(call, "expectedRevision") : null, records };
}

function validateHeaderArrays(headers, stage) {
  if (!hasExactOwnKeys(headers, HEADER_KEYS)) {
    graphError("INPUT_INVALID", stage, "headers must have the exact required own keys");
  }
  for (const key of HEADER_KEYS) {
    if (!isDenseArray(read(headers, key), { strings: true })) {
      graphError("INPUT_INVALID", stage, `${key} must be a dense string array`);
    }
  }
}

function validateRecordInput(record, stage) {
  if (!hasExactOwnKeys(record, RECORD_KEYS)) {
    graphError("INPUT_INVALID", stage, "record must have the exact required own keys");
  }
  if (!ENDPOINTS.has(read(record, "endpoint")) || !PLATFORMS.has(read(record, "platform"))) {
    graphError("INPUT_INVALID", stage, "record endpoint or platform is invalid");
  }
  const requestedDigest = read(record, "requestedDigest");
  const digestShapeValid = stage === "named-index"
    ? requestedDigest === null
    : typeof requestedDigest === "string" && SHA256.test(requestedDigest);
  if (!digestShapeValid) {
    graphError("INPUT_INVALID", stage, "requestedDigest has the wrong shape for this stage");
  }
  if (!DESCRIPTOR_MEDIA_TYPES.has(read(record, "expectedMediaType"))) {
    graphError("INPUT_INVALID", stage, "expectedMediaType is not an authorized descriptor media type");
  }
  const expectedSize = read(record, "expectedSize");
  const sizeShapeValid = stage.endsWith("-index") ? expectedSize === null : isSafeSize(expectedSize);
  if (!sizeShapeValid) {
    graphError("INPUT_INVALID", stage, "expectedSize has the wrong shape for this stage");
  }
  if (!Number.isInteger(read(record, "status"))) {
    graphError("INPUT_INVALID", stage, "status must be an integer");
  }
  validateHeaderArrays(read(record, "headers"), stage);
  if (!(read(record, "body") instanceof Uint8Array)) {
    graphError("INPUT_INVALID", stage, "body must be a Uint8Array");
  }
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
  for (const key of Reflect.ownKeys(value)) {
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
  for (const forbidden of ["urls", "data", "artifactType"]) {
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
    for (const forbidden of ["variant", "os.version", "os.features"]) {
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

  const manifests = requireOwn(value, "manifests", stage, "index");
  if (!Array.isArray(manifests) || manifests.length !== 2) schemaFailure(stage, "index must contain exactly two descriptors");
  const byPlatform = new Map();
  for (const descriptorValue of manifests) {
    const descriptor = validateDescriptor(descriptorValue, stage, {
      mediaTypes: new Set([MANIFEST_MEDIA_TYPE]),
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
    mediaTypes: new Set([CONFIG_MEDIA_TYPE]),
    platform: "forbidden",
  });
  const layers = requireOwn(value, "layers", stage, "manifest");
  if (!Array.isArray(layers) || layers.length === 0) schemaFailure(stage, "manifest layers must be a nonempty array");
  for (const layer of layers) {
    validateDescriptor(layer, stage, { mediaTypes: LAYER_MEDIA_TYPES, platform: "forbidden" });
  }
  return { config };
}

function validateConfig(value, stage, platform) {
  requireObject(value, stage, "config body");
  validateOptionalAnnotations(value, stage, "config body");
  const [os, architecture] = platform.split("/");
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
    const record = records[index];
    const expectedStage = STAGES[index];
    const suppliedStage = isObject(record) && has(record, "stage") ? read(record, "stage") : null;
    if (!STAGE_SET.has(suppliedStage)) {
      graphError("INPUT_INVALID", "input", "record stage is missing or invalid");
    }
    if (suppliedStage !== expectedStage) {
      graphError("STAGE_ORDER", suppliedStage, "record stage is not the next canonical stage");
    }

    validateRecordInput(record, expectedStage);
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
