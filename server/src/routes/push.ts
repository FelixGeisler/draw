import { Router, type Request, type RequestHandler, type Response } from "express";
import { PushApiError, type PushServiceDependency } from "../push/service.js";
import { PushResolutionError } from "../push/resolver.js";

export const MAX_PUSH_BODY_BYTES = 8_192;

function sendError(res: Response, error: PushApiError): void {
  if (error.retryAfter !== undefined) res.set("Retry-After", String(error.retryAfter));
  res.status(error.status).json({ error: error.code });
}

function noBody(req: Request, res: Response, next: () => void): void {
  const transfer = req.rawHeaders.some((value, index) => index % 2 === 0 && value.toLowerCase() === "transfer-encoding");
  const lengths = req.rawHeaders
    .map((value, index) => index % 2 === 0 && value.toLowerCase() === "content-length" ? req.rawHeaders[index + 1] : undefined)
    .filter((value): value is string => value !== undefined);
  if (transfer || lengths.length > 1 || (lengths.length === 1 && (!/^\d+$/.test(lengths[0]) || Number(lengths[0]) !== 0))) {
    sendError(res, new PushApiError(400, "invalid-push-request"));
    return;
  }
  next();
}

function readJson(req: Request): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const encoding = req.headers["content-encoding"];
    if (encoding !== undefined && encoding.toLowerCase().trim() !== "identity") {
      reject(new PushApiError(415, "push-json-required"));
      req.resume();
      return;
    }
    if (req.is("application/json") !== "application/json") {
      reject(new PushApiError(415, "push-json-required"));
      req.resume();
      return;
    }
    const declared = req.headers["content-length"];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_PUSH_BODY_BYTES)) {
      reject(Number(declared) > MAX_PUSH_BODY_BYTES
        ? new PushApiError(413, "push-body-too-large")
        : new PushApiError(400, "invalid-push-request"));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let done = false;
    const finish = (error?: PushApiError) => {
      if (done) return;
      done = true;
      if (error) reject(error);
      else {
        try {
          if (bytes === 0) throw new Error("empty");
          const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
          const value: unknown = JSON.parse(text);
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not object");
          resolve(value);
        } catch {
          reject(new PushApiError(400, "invalid-push-request"));
        }
      }
    };
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > MAX_PUSH_BODY_BYTES) {
        finish(new PushApiError(413, "push-body-too-large"));
        req.resume();
      } else chunks.push(Buffer.from(chunk));
    });
    req.on("end", () => finish());
    req.on("error", () => finish(new PushApiError(400, "invalid-push-request")));
    req.on("aborted", () => finish(new PushApiError(400, "invalid-push-request")));
  });
}

const asyncRoute = (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => { handler(req, res).catch(next); };

export function createPushRouter(push: PushServiceDependency): Router {
  const router = Router();

  router.get("/status", noBody, (req, res) => {
    const topology = push.topology(req, false);
    const status = push.status();
    res.status(200).json({
      available: status.available,
      reason: status.reason,
      mutationAllowed: topology.allowed,
      mutationReason: topology.allowed ? null : topology.reason,
      vapidPublicKey: status.vapidPublicKey,
      maxDevices: status.maxDevices,
      preferences: status.preferences,
      devices: status.devices,
    });
  });

  router.all(["/test", "/subscriptions/:deviceId/test"], noBody, (_req, _res, next) => next());

  router.post("/subscriptions", asyncRoute(async (req, res) => {
    const topology = push.topology(req, true);
    if (!topology.allowed) throw new PushApiError(403, "push-mutation-forbidden");
    const body = await readJson(req);
    const abort = new AbortController();
    const clientDisconnected = () => req.aborted || req.socket.destroyed || res.destroyed;
    const onDisconnect = () => {
      if (!res.writableEnded) abort.abort();
    };
    req.once("aborted", onDisconnect);
    res.once("close", onDisconnect);
    if (clientDisconnected()) abort.abort();
    try {
      const result = await push.register(body, topology.clientKey, abort.signal);
      if (!res.headersSent && !clientDisconnected()) res.status(result.created ? 201 : 200).json({ device: result.device });
    } finally {
      req.off("aborted", onDisconnect);
      res.off("close", onDisconnect);
    }
  }));

  router.post("/subscriptions/:deviceId/test", asyncRoute(async (req, res) => {
    const topology = push.topology(req, true);
    if (!topology.allowed) throw new PushApiError(403, "push-mutation-forbidden");
    const deviceId = req.params.deviceId;
    if (typeof deviceId !== "string") throw new PushApiError(400, "invalid-push-request");
    const abort = new AbortController();
    const clientDisconnected = () => req.aborted || req.socket.destroyed || res.destroyed;
    const onDisconnect = () => {
      if (!res.writableEnded) abort.abort();
    };
    req.once("aborted", onDisconnect);
    res.once("close", onDisconnect);
    if (clientDisconnected()) abort.abort();
    try {
      await push.testDevice(deviceId, abort.signal);
      if (!res.headersSent && !clientDisconnected()) res.status(204).end();
    } finally {
      req.off("aborted", onDisconnect);
      res.off("close", onDisconnect);
    }
  }));

  router.put("/preferences", asyncRoute(async (req, res) => {
    const topology = push.topology(req, true);
    if (!topology.allowed) throw new PushApiError(403, "push-mutation-forbidden");
    const body = await readJson(req);
    res.status(200).json(push.setPreferences(body));
  }));

  router.delete("/subscriptions/:deviceId", noBody, (req, res, next) => {
    try {
      const topology = push.topology(req, true);
      if (!topology.allowed) throw new PushApiError(403, "push-mutation-forbidden");
      const deviceId = req.params.deviceId;
      if (typeof deviceId !== "string") throw new PushApiError(400, "invalid-push-request");
      push.deleteDevice(deviceId);
      res.status(204).end();
    } catch (error) { next(error); }
  });

  router.delete("/subscriptions", noBody, (req, res, next) => {
    try {
      const topology = push.topology(req, true);
      if (!topology.allowed) throw new PushApiError(403, "push-mutation-forbidden");
      push.revokeAllDevices();
      res.status(204).end();
    } catch (error) { next(error); }
  });

  // Future Push routes inherit no-body framing before the API 404. The only
  // current body-bearing routes are the two exact mutations above.
  router.use(noBody);

  router.use((error: unknown, req: Request, res: Response, next: (error?: unknown) => void) => {
    if (res.headersSent || req.aborted || error instanceof PushResolutionError && error.kind === "aborted") return;
    if (error instanceof PushApiError) {
      sendError(res, error);
      return;
    }
    // The Push namespace never emits Express HTML/prose or internal details.
    sendError(res, new PushApiError(503, "push-unavailable"));
  });
  return router;
}
