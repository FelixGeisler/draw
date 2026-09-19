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

export type PushTransportOwnedEvent = "agent-destroy" | "request-close" | "response-close" | "socket-close";

export interface NodePushTransportOptions {
  /** Test-only trust seam for an ephemeral certificate; production passes nothing. */
  ca?: string | Buffer | (string | Buffer)[];
  /** Test-only observation of locally owned terminal events; production passes nothing. */
  onOwnedEvent?: (event: PushTransportOwnedEvent) => void;
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
      const closePromises = new Set<Promise<void>>();
      const observeClose = (owned: NodeJS.EventEmitter, event: Exclude<PushTransportOwnedEvent, "agent-destroy">): Promise<void> => {
        let resolveClose!: () => void;
        const closed = new Promise<void>((resolve) => { resolveClose = resolve; });
        owned.once("close", () => {
          options.onOwnedEvent?.(event);
          resolveClose();
        });
        closePromises.add(closed);
        return closed;
      };
      let response: import("node:http").IncomingMessage | undefined;
      let complete = false;
      let settled = false;
      let agentDestroyed = false;
      const destroyAgent = () => {
        if (agentDestroyed) return;
        agentDestroyed = true;
        agent.destroy();
        options.onOwnedEvent?.("agent-destroy");
      };
      let resolveResult!: (result: PushTransportResult) => void;
      const result = new Promise<PushTransportResult>((resolve) => { resolveResult = resolve; });
      const finish = (value: PushTransportResult) => {
        if (settled) return;
        settled = true;
        resolveResult(value);
      };
      const abortedResult = (): PushTransportResult => input.timedOut() ? "timeout" : "aborted";

      let outgoing: import("node:http").ClientRequest;
      let requestClosed: Promise<void>;
      try {
        outgoing = https.request(input.details.endpoint, {
          method: input.details.method,
          headers: input.details.headers,
          agent,
        }, (incoming) => {
          response = incoming;
          observeClose(incoming, "response-close");
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
        requestClosed = observeClose(outgoing, "request-close");
      } catch {
        destroyAgent();
        return Promise.resolve(input.signal.aborted ? abortedResult() : "failed");
      }

      outgoing.on("socket", (socket) => { observeClose(socket, "socket-close"); });
      outgoing.once("error", () => finish(input.signal.aborted ? abortedResult() : "failed"));
      outgoing.once("close", () => {
        if (!settled && !complete) finish(input.signal.aborted ? abortedResult() : "failed");
      });
      const onAbort = () => {
        response?.destroy();
        outgoing.destroy();
        destroyAgent();
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
        destroyAgent();
        // `destroyed` only means destruction was initiated. Admission remains
        // held until each owned request, response, and socket reports `close`.
        await requestClosed;
        await Promise.all([...closePromises]);
      });
    },
  };
}
