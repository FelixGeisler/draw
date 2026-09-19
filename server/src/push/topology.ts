import net from "node:net";
import type { Request } from "express";
import { ipv4Bytes, ipv6Bytes } from "./destination.js";

export type MutationReason = "secure-transport-required" | "proxy-configuration-unsupported";
export type TopologyResult =
  | { allowed: true; clientKey: string }
  | { allowed: false; reason: MutationReason };

export interface PushTopologyOptions {
  listenerHost: string;
  listenerPort: number | (() => number);
  trustProxy: boolean | number | string;
}

function headerOccurrences(req: Request, name: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index].toLowerCase() === name) found.push(req.rawHeaders[index + 1]);
  }
  return found;
}

export function normalizeIp(value: string | undefined): string | null {
  if (!value) return null;
  const family = net.isIP(value);
  if (family === 4) return [...ipv4Bytes(value)].join(".");
  if (family !== 6) return null;
  const bytes = ipv6Bytes(value);
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return [...bytes.slice(12)].join(".");
  }
  const words = Array.from({ length: 8 }, (_, index) => (bytes[index * 2] << 8) | bytes[index * 2 + 1]);
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < words.length; ) {
    if (words[index] !== 0) { index += 1; continue; }
    let end = index;
    while (end < words.length && words[end] === 0) end += 1;
    if (end - index > bestLength && end - index >= 2) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  if (bestStart >= 0) {
    const left = words.slice(0, bestStart).map((word) => word.toString(16)).join(":");
    const right = words.slice(bestStart + bestLength).map((word) => word.toString(16)).join(":");
    return `${left}::${right}`;
  }
  return words.map((word) => word.toString(16)).join(":");
}

interface Authority {
  serializedHost: string;
  effectivePort: number;
  explicitPort: boolean;
  origin: string;
}

function dnsName(value: string): boolean {
  if (!value || value.length > 253 || value !== value.toLowerCase() || value.endsWith(".")) return false;
  return value.split(".").every((label) =>
    label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
  );
}

function parseAuthority(raw: string, scheme: "http" | "https"): Authority | null {
  if (!raw || raw.includes(",") || /[\s/@?#]/.test(raw)) return null;
  let host: string;
  let serializedHost: string;
  let portText: string | undefined;
  if (raw.startsWith("[")) {
    const close = raw.indexOf("]");
    if (close < 0) return null;
    host = raw.slice(1, close);
    const normalized = normalizeIp(host);
    if (!normalized || net.isIP(host) !== 6 || normalized !== host.toLowerCase()) return null;
    serializedHost = `[${normalized}]`;
    const rest = raw.slice(close + 1);
    if (rest) {
      if (!rest.startsWith(":")) return null;
      portText = rest.slice(1);
    }
  } else {
    const colon = raw.lastIndexOf(":");
    if (colon >= 0) {
      if (raw.indexOf(":") !== colon) return null;
      host = raw.slice(0, colon);
      portText = raw.slice(colon + 1);
    } else host = raw;
    const family = net.isIP(host);
    if (family === 6) return null;
    if (family === 4) {
      const normalized = normalizeIp(host);
      if (!normalized || normalized !== host) return null;
      serializedHost = normalized;
    } else {
      if (!dnsName(host)) return null;
      serializedHost = host;
    }
  }
  const defaultPort = scheme === "https" ? 443 : 80;
  let port = defaultPort;
  if (portText !== undefined) {
    if (!/^[1-9]\d{0,4}$/.test(portText)) return null;
    port = Number(portText);
    if (port > 65_535) return null;
  }
  const originPort = port === defaultPort ? "" : `:${port}`;
  return { serializedHost, effectivePort: port, explicitPort: portText !== undefined, origin: `${scheme}://${serializedHost}${originPort}` };
}

function isLoopbackIp(value: string | null): boolean {
  if (value === "::1") return true;
  return value !== null && net.isIP(value) === 4 && ipv4Bytes(value)[0] === 127;
}

function configuredLoopback(value: string): boolean {
  const host = value.trim().toLowerCase();
  return host === "localhost" || isLoopbackIp(normalizeIp(host));
}

function forwardingPresent(req: Request): boolean {
  return req.rawHeaders.some((name, index) =>
    index % 2 === 0 && (name.toLowerCase() === "forwarded" || name.toLowerCase() === "x-real-ip" || name.toLowerCase().startsWith("x-forwarded-")),
  );
}

function validMutationHeaders(req: Request, expectedOrigin: string): boolean {
  const origins = headerOccurrences(req, "origin");
  if (origins.length !== 1 || origins[0] !== expectedOrigin) return false;
  const sites = headerOccurrences(req, "sec-fetch-site");
  return sites.length === 0 || (sites.length === 1 && ["same-origin", "none"].includes(sites[0]));
}

function trustedPeer(req: Request, peer: string): boolean {
  const trust = req.app.get("trust proxy fn") as ((address: string, hop: number) => boolean) | undefined;
  return Boolean(trust?.(peer, 0));
}

export function evaluatePushTopology(
  req: Request,
  options: PushTopologyOptions,
  mutation: boolean,
): TopologyResult {
  const hostValues = headerOccurrences(req, "host");
  const hostRaw = hostValues.length === 1 ? hostValues[0] : "";
  const peer = normalizeIp(req.socket.remoteAddress);
  const forwarded = forwardingPresent(req);
  const configuredPort = typeof options.listenerPort === "function" ? options.listenerPort() : options.listenerPort;

  if (!req.secure && !forwarded) {
    const authority = parseAuthority(hostRaw, "http");
    const allowedHost = authority && (
      authority.serializedHost === "localhost" ||
      authority.serializedHost === "[::1]" ||
      (net.isIP(authority.serializedHost) === 4 && isLoopbackIp(authority.serializedHost))
    );
    const loopbackPeer = isLoopbackIp(peer);
    if (
      (options.trustProxy !== false && options.trustProxy !== 0) ||
      !configuredLoopback(options.listenerHost) || !loopbackPeer || !allowedHost || !authority!.explicitPort ||
      authority!.effectivePort !== configuredPort ||
      (mutation && !validMutationHeaders(req, `http://${authority!.serializedHost}:${configuredPort}`))
    ) {
      return { allowed: false, reason: "secure-transport-required" };
    }
    return { allowed: true, clientKey: peer! };
  }

  if (req.secure && !forwarded) {
    const authority = parseAuthority(hostRaw, "https");
    if (!authority || (mutation && !validMutationHeaders(req, authority.origin))) {
      return { allowed: false, reason: "secure-transport-required" };
    }
    return { allowed: true, clientKey: normalizeIp(req.ip) ?? peer ?? "unknown" };
  }

  // Any forwarding claim is all-or-nothing. Unknown/legacy headers and an
  // untrusted immediate peer cannot influence transport or client identity.
  const allowedNames = new Set(["x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-real-ip"]);
  const names = req.rawHeaders
    .filter((_value, index) => index % 2 === 0)
    .map((name) => name.toLowerCase())
    .filter((name) => name === "forwarded" || name === "x-real-ip" || name.startsWith("x-forwarded-"));
  if (
    names.some((name) => !allowedNames.has(name)) ||
    options.trustProxy === false || options.trustProxy === 0 || !peer || !trustedPeer(req, peer)
  ) return { allowed: false, reason: "proxy-configuration-unsupported" };

  const xff = headerOccurrences(req, "x-forwarded-for");
  const proto = headerOccurrences(req, "x-forwarded-proto");
  const xhost = headerOccurrences(req, "x-forwarded-host");
  const realIp = headerOccurrences(req, "x-real-ip");
  const chain = xff.length === 1 ? xff[0].split(",").map((value) => value.trim()) : [];
  const host = parseAuthority(hostRaw, "https");
  const client = normalizeIp(req.ip);
  const structureValid =
    host && xff.length === 1 && chain.length > 0 && chain.every((value) => normalizeIp(value)) &&
    proto.length === 1 && xhost.length <= 1 && realIp.length <= 1 &&
    (realIp.length === 0 || normalizeIp(realIp[0])) && client;
  if (!structureValid) return { allowed: false, reason: "proxy-configuration-unsupported" };
  if (!req.secure && proto[0] === "http") {
    return { allowed: false, reason: "secure-transport-required" };
  }
  if (!req.secure || proto[0] !== "https") {
    return { allowed: false, reason: "proxy-configuration-unsupported" };
  }
  if (xhost.length === 1) {
    const forwardedHost = parseAuthority(xhost[0], "https");
    if (!forwardedHost || forwardedHost.serializedHost !== host.serializedHost || forwardedHost.effectivePort !== host.effectivePort) {
      return { allowed: false, reason: "proxy-configuration-unsupported" };
    }
  }
  if (mutation && !validMutationHeaders(req, host.origin)) {
    return { allowed: false, reason: "proxy-configuration-unsupported" };
  }
  return { allowed: true, clientKey: client! };
}
