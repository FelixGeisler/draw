import { parseStrictJson } from "./strict-json.mjs";
import { validateOciGraph } from "./oci-graph-validator.mjs";

const REGISTRY_ORIGIN = "https://ghcr.io";
const TOKEN_URL = "https://ghcr.io/token?service=ghcr.io&scope=repository%3Afelixgeisler%2Fdraw%3Apull";
const REPOSITORY_PATH = "/v2/felixgeisler/draw";
const INDEX_MEDIA_TYPE = "application/vnd.oci.image.index.v1+json";
const MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";
const CONFIG_MEDIA_TYPE = "application/vnd.oci.image.config.v1+json";
const OCTET_STREAM = "application/octet-stream";
const JSON_MEDIA_TYPE = "application/json";
const MAX_RESPONSE_BYTES = 1_048_576;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_REGISTRY_REQUESTS = 7;
const MAX_TOTAL_REQUESTS = 8;

export class GhcrInspectionError extends Error {
  constructor(code) {
    super(code);
    this.name = "GhcrInspectionError";
    this.code = code;
  }
}

export class GhcrImageNotFoundError extends Error {
  constructor() {
    super("image not found");
    this.name = "GhcrImageNotFoundError";
  }
}

function fail(code) {
  throw new GhcrInspectionError(code);
}

function own(value, key) {
  return Object.hasOwn(value, key);
}

function headerValues(headers, name) {
  const value = headers.get(name);
  return value === null ? [] : [value];
}

function responseHeaders(response) {
  return {
    contentType: headerValues(response.headers, "content-type"),
    contentEncoding: headerValues(response.headers, "content-encoding"),
    dockerContentDigest: headerValues(response.headers, "docker-content-digest"),
  };
}

function validateIdentityEncoding(response) {
  const value = response.headers.get("content-encoding");
  if (value !== null && value !== "identity") fail("response encoding is not identity");
}

function validateJsonContentType(response) {
  const value = response.headers.get("content-type");
  if (value === null) fail("JSON response content type is missing");
  const parts = value.split(";");
  if (parts.length > 2 || parts[0].trim().toLowerCase() !== JSON_MEDIA_TYPE) {
    fail("JSON response content type is invalid");
  }
  if (parts.length === 2) {
    const parameter = parts[1].trim().match(/^([^=]+)=([^=]+)$/);
    if (!parameter || parameter[1].trim().toLowerCase() !== "charset" || parameter[2].trim().toLowerCase() !== "utf-8") {
      fail("JSON response content type is invalid");
    }
  }
}

async function readBounded(response, abortRequest) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) fail("response stream is invalid");
      length += item.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        abortRequest();
        try {
          const cancellation = reader.cancel();
          cancellation.catch(() => {});
        } catch { /* cancellation is best effort after the abort request */ }
        fail("response exceeds byte limit");
      }
      chunks.push(item.value);
    }
  } catch (error) {
    if (error instanceof GhcrInspectionError) throw error;
    fail("response stream failed");
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    body.set(chunks[index], offset);
    offset += chunks[index].byteLength;
  }
  return body;
}

function parseJson(body) {
  try {
    return parseStrictJson(body);
  } catch {
    fail("response JSON is invalid");
  }
}

function isPlainJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactOwnStringKeys(value, required, optional = []) {
  if (!isPlainJsonObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return false;
  const allowed = new Set([...required, ...optional]);
  if (keys.some((key) => !allowed.has(key))) return false;
  return required.every((key) => own(value, key));
}

function validScalarMessage(value) {
  if (typeof value !== "string") return false;
  let scalars = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
    scalars += 1;
    if (scalars > 512) return false;
  }
  return scalars > 0;
}

function validateDistributionError(value, requiredCode) {
  if (!exactOwnStringKeys(value, ["errors"]) || !Array.isArray(value.errors) || value.errors.length === 0) {
    fail("registry error response is invalid");
  }
  for (let index = 0; index < value.errors.length; index += 1) {
    const entry = value.errors[index];
    if (!exactOwnStringKeys(entry, ["code", "message"], ["detail"]) ||
        entry.code !== requiredCode || !validScalarMessage(entry.message)) {
      fail("registry error response is invalid");
    }
  }
}

function parseBearerChallenge(value) {
  if (typeof value !== "string") fail("Bearer challenge is missing");
  const challenge = value.match(/^[\t ]*Bearer[\t ]+(.+?)[\t ]*$/i);
  if (!challenge) fail("Bearer challenge is invalid");
  const parameters = challenge[1].split(",");
  if (parameters.length !== 3) fail("Bearer challenge is invalid");
  const values = new Map();
  for (let index = 0; index < parameters.length; index += 1) {
    const parameter = parameters[index].match(/^[\t ]*([A-Za-z][A-Za-z0-9_-]*)[\t ]*=[\t ]*"([\x21\x23-\x2b\x2d-\x5b\x5d-\x7e]*)"[\t ]*$/);
    if (!parameter) fail("Bearer challenge is invalid");
    const name = parameter[1].toLowerCase();
    if (values.has(name)) fail("Bearer challenge is invalid");
    values.set(name, parameter[2]);
  }
  if (values.size !== 3 ||
      values.get("realm") !== "https://ghcr.io/token" ||
      values.get("service") !== "ghcr.io" ||
      values.get("scope") !== "repository:felixgeisler/draw:pull") {
    fail("Bearer challenge is invalid");
  }
}

function validateToken(value) {
  if (!isPlainJsonObject(value) || !own(value, "token") || typeof value.token !== "string" ||
      !/^[A-Za-z0-9\-._~+/]+={0,}$/.test(value.token)) {
    fail("token response is invalid");
  }
  return value.token;
}

function expectedAccept(stage, endpoint) {
  if (stage === "named-index" || stage === "digest-index") return INDEX_MEDIA_TYPE;
  if (endpoint === "blobs") return OCTET_STREAM;
  return MANIFEST_MEDIA_TYPE;
}

function makeRegistryUrl(tag, plan) {
  if (plan.stage === "named-index") return `${REGISTRY_ORIGIN}${REPOSITORY_PATH}/manifests/${tag}`;
  const endpoint = plan.endpoint === "manifests" ? "manifests" : plan.endpoint === "blobs" ? "blobs" : null;
  if (!endpoint || !/^sha256:[0-9a-f]{64}$/.test(plan.digest)) fail("core fetch plan is invalid");
  return `${REGISTRY_ORIGIN}${REPOSITORY_PATH}/${endpoint}/${plan.digest}`;
}

function assertCanonicalRequest(request, kind, expectedUrl, expectedAccept, expectedAuthorization) {
  const url = new URL(request.url);
  const expectedHeaderNames = expectedAuthorization === null
    ? ["accept", "accept-encoding"]
    : ["accept", "accept-encoding", "authorization"];
  if (request.method !== "GET" || request.redirect !== "error" || url.protocol !== "https:" ||
      request.url !== expectedUrl || request.headers.get("accept") !== expectedAccept ||
      request.headers.get("accept-encoding") !== "identity" ||
      request.headers.get("authorization") !== expectedAuthorization ||
      JSON.stringify([...request.headers.keys()].sort()) !== JSON.stringify(expectedHeaderNames)) {
    fail("request policy rejected dispatch");
  }
  if (kind === "token") {
    if (request.url !== TOKEN_URL || expectedAccept !== JSON_MEDIA_TYPE || url.origin !== REGISTRY_ORIGIN) {
      fail("request policy rejected dispatch");
    }
  } else if (url.origin !== REGISTRY_ORIGIN || !url.pathname.startsWith(`${REPOSITORY_PATH}/`) || url.search || url.hash) {
    fail("request policy rejected dispatch");
  }
}

function combineSignals(overallSignal, requestSignal) {
  return AbortSignal.any([overallSignal, requestSignal]);
}

export async function inspectGhcrImage({ tag, expectedRevision, credentials, transport, overallSignal, startOverallDeadline }) {
  const records = [];
  let bearerToken = null;
  let tokenExchanged = false;
  let registryRequests = 0;
  let totalRequests = 0;
  let overallDeadlineStarted = false;

  const dispatch = async ({ url, accept, authorization, kind }) => {
    if (overallSignal.aborted) fail("inspection was aborted");
    if (totalRequests >= MAX_TOTAL_REQUESTS || (kind === "registry" && registryRequests >= MAX_REGISTRY_REQUESTS)) {
      fail("request allowance exhausted");
    }
    totalRequests += 1;
    if (kind === "registry") registryRequests += 1;

    const requestController = new AbortController();
    const timer = setTimeout(() => requestController.abort(), REQUEST_TIMEOUT_MS);
    const headers = new Headers({ Accept: accept, "Accept-Encoding": "identity" });
    if (authorization !== null) headers.set("Authorization", authorization);
    const request = new Request(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: combineSignals(overallSignal, requestController.signal),
    });
    assertCanonicalRequest(request, kind, url, accept, authorization);

    try {
      let response;
      try {
        if (!overallDeadlineStarted) {
          startOverallDeadline();
          overallDeadlineStarted = true;
        }
        response = await transport(request);
      } catch {
        fail(request.signal.aborted ? "request timed out or was aborted" : "transport request failed");
      }
      if (!(response instanceof Response)) fail("transport returned an invalid response");
      const body = await readBounded(response, () => requestController.abort());
      validateIdentityEncoding(response);
      return { response, body };
    } finally {
      clearTimeout(timer);
    }
  };

  const tokenRequest = async () => {
    if (tokenExchanged) fail("token exchange already used");
    tokenExchanged = true;
    const basic = credentials === null
      ? null
      : `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`, "ascii").toString("base64")}`;
    const { response, body } = await dispatch({
      url: TOKEN_URL,
      accept: JSON_MEDIA_TYPE,
      authorization: basic,
      kind: "token",
    });
    validateJsonContentType(response);
    const value = parseJson(body);
    if (response.status !== 200) fail("token request failed");
    return validateToken(value);
  };

  const registryRequest = async (plan, allowInitialAuth) => {
    const accept = expectedAccept(plan.stage, plan.endpoint);
    const authorization = bearerToken === null ? null : `Bearer ${bearerToken}`;
    const result = await dispatch({
      url: makeRegistryUrl(tag, plan),
      accept,
      authorization,
      kind: "registry",
    });
    const { response, body } = result;

    if (response.status === 401) {
      validateJsonContentType(response);
      validateDistributionError(parseJson(body), "UNAUTHORIZED");
      if (!allowInitialAuth || bearerToken !== null || tokenExchanged) fail("registry authorization failed");
      parseBearerChallenge(response.headers.get("www-authenticate"));
      bearerToken = await tokenRequest();
      return registryRequest(plan, false);
    }

    if (response.status === 404) {
      validateJsonContentType(response);
      validateDistributionError(parseJson(body), "MANIFEST_UNKNOWN");
      if (plan.stage === "named-index") throw new GhcrImageNotFoundError();
      fail("registry content was not found");
    }

    if (response.status !== 200) {
      validateJsonContentType(response);
      parseJson(body);
      fail("registry request failed");
    }
    return result;
  };

  let plan = {
    stage: "named-index",
    endpoint: "manifests",
    platform: null,
    digest: null,
    mediaType: INDEX_MEDIA_TYPE,
    size: null,
  };
  let result;
  while (true) {
    const { response, body } = await registryRequest(plan, plan.stage === "named-index" && records.length === 0);
    records.push({
      stage: plan.stage,
      endpoint: plan.endpoint,
      platform: plan.platform,
      requestedDigest: plan.digest,
      expectedMediaType: plan.mediaType,
      expectedSize: plan.size,
      status: response.status,
      headers: responseHeaders(response),
      body,
    });
    if (overallSignal.aborted) fail("inspection was aborted");
    result = expectedRevision === undefined
      ? validateOciGraph({ mode: "derive", records })
      : validateOciGraph({ mode: "expected", expectedRevision, records });
    if (overallSignal.aborted) fail("inspection was aborted");
    if (result.fetchPlan.length === 0) return result;
    if (result.fetchPlan.length !== 1) fail("core fetch plan is invalid");
    plan = result.fetchPlan[0];
  }
}
