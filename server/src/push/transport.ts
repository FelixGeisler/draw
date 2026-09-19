import https from "node:https";
import net from "node:net";
import type { RequestDetails } from "web-push";

export type PushTransportResult = "success" | "gone" | "failed" | "timeout" | "aborted";

export interface PushTransportRequest {
  details: RequestDetails & { body: Buffer };
  hostname: string;
  address: string;
  signal: AbortSignal;
  timedOut: () => boolean;
}

export interface PushTransport {
  send(request: PushTransportRequest): Promise<PushTransportResult>;
}

export const inertPushTransport: PushTransport = Object.freeze({
  send: async () => "failed" as const,
});

export interface NodePushTransportOptions {
  /** Test-only trust seam for an ephemeral certificate; production passes nothing. */
  ca?: string | Buffer | (string | Buffer)[];
}

function lookupFor(hostname: string, address: string): NonNullable<https.AgentOptions["lookup"]> {
  const family = net.isIP(address);
  if (family !== 4 && family !== 6) throw new Error("invalid pinned address");
  return ((requested: string, options: unknown, callback: (...args: unknown[]) => void) => {
    if (requested !== hostname) {
      const error = Object.assign(new Error("lookup hostname mismatch"), { code: "ENOTFOUND" });
      callback(error);
      return;
    }
    const all = typeof options === "object" && options !== null && "all" in options &&
      (options as { all?: boolean }).all === true;
    if (all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  }) as NonNullable<https.AgentOptions["lookup"]>;
}

/** One core-HTTPS request, one pinned lookup, one non-reusable agent. */
export function createNodePushTransport(options: NodePushTransportOptions = {}): PushTransport {
  return {
    send(input): Promise<PushTransportResult> {
      // This function deliberately creates and ends the request synchronously.
      // The caller's final state check and this non-recallable boundary have no yield between them.
      const agent = new https.Agent({
        keepAlive: false,
        maxSockets: 1,
        maxTotalSockets: 1,
        lookup: lookupFor(input.hostname, input.address),
        ...(options.ca === undefined ? {} : { ca: options.ca }),
      });
      const sockets = new Set<import("node:net").Socket>();
      let response: import("node:http").IncomingMessage | undefined;
      let complete = false;
      let settled = false;
      let resolveResult!: (result: PushTransportResult) => void;
      const result = new Promise<PushTransportResult>((resolve) => { resolveResult = resolve; });
      const finish = (value: PushTransportResult) => {
        if (settled) return;
        settled = true;
        resolveResult(value);
      };
      const abortedResult = (): PushTransportResult => input.timedOut() ? "timeout" : "aborted";

      let outgoing: import("node:http").ClientRequest;
      try {
        outgoing = https.request(input.details.endpoint, {
          method: input.details.method,
          headers: input.details.headers,
          agent,
        }, (incoming) => {
          response = incoming;
          let bytes = 0;
          incoming.on("data", (chunk: Buffer | string) => {
            bytes += Buffer.byteLength(chunk);
            if (bytes > 4_096) {
              incoming.destroy();
              outgoing.destroy();
              finish(input.signal.aborted ? abortedResult() : "failed");
            }
          });
          incoming.once("end", () => {
            complete = true;
            const status = incoming.statusCode ?? 0;
            if (status >= 200 && status <= 299) finish("success");
            else if (status === 404 || status === 410) finish("gone");
            else finish("failed");
          });
          incoming.once("aborted", () => finish(input.signal.aborted ? abortedResult() : "failed"));
          incoming.once("error", () => finish(input.signal.aborted ? abortedResult() : "failed"));
          incoming.once("close", () => {
            if (!complete) finish(input.signal.aborted ? abortedResult() : "failed");
          });
        });
      } catch {
        agent.destroy();
        return Promise.resolve(input.signal.aborted ? abortedResult() : "failed");
      }

      outgoing.on("socket", (socket) => sockets.add(socket));
      outgoing.once("error", () => finish(input.signal.aborted ? abortedResult() : "failed"));
      outgoing.once("close", () => {
        if (!settled && !complete) finish(input.signal.aborted ? abortedResult() : "failed");
      });
      const onAbort = () => {
        response?.destroy();
        outgoing.destroy();
        agent.destroy();
        finish(abortedResult());
      };
      input.signal.addEventListener("abort", onAbort, { once: true });
      if (input.signal.aborted) onAbort();
      else {
        try { outgoing.end(input.details.body); }
        catch {
          outgoing.destroy();
          finish("failed");
        }
      }

      return result.finally(async () => {
        input.signal.removeEventListener("abort", onAbort);
        response?.destroy();
        outgoing.destroy();
        agent.destroy();
        await Promise.all([...sockets].map((socket) => socket.destroyed
          ? Promise.resolve()
          : new Promise<void>((resolve) => socket.once("close", () => resolve()))));
      });
    },
  };
}
