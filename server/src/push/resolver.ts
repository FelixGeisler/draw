import { promises as dns } from "node:dns";
import { selectPermittedAddress } from "./destination.js";

export interface IsolatedResolver {
  resolve4(hostname: string, options: { ttl: false }): Promise<string[]>;
  resolve6(hostname: string, options: { ttl: false }): Promise<string[]>;
  cancel(): void;
}

export type ResolverFactory = () => IsolatedResolver;

export class PushResolutionError extends Error {
  constructor(readonly kind: "unavailable" | "timeout" | "aborted") {
    super(kind);
  }
}

const noData = (reason: unknown): boolean => {
  const code = (reason as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENODATA" || code === "ENOTFOUND";
};

export const nodeResolverFactory: ResolverFactory = () => new dns.Resolver();

/** One logical attempt owns one Resolver and never releases it before both RR operations settle. */
export async function resolvePushEndpoint(
  hostname: string,
  factory: ResolverFactory = nodeResolverFactory,
  signal?: AbortSignal,
  deadlineMs = 2_000,
): Promise<string> {
  const resolver = factory();
  let timedOut = false;
  let aborted = signal?.aborted ?? false;
  let settled = false;
  const cancel = () => {
    if (!settled) resolver.cancel();
  };
  const onAbort = () => {
    aborted = true;
    cancel();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    cancel();
  }, deadlineMs);

  const invoke = (operation: () => Promise<string[]>): Promise<string[]> => {
    try { return Promise.resolve(operation()); }
    catch (error) { return Promise.reject(error); }
  };
  const operations = [
    invoke(() => resolver.resolve4(hostname, { ttl: false })),
    invoke(() => resolver.resolve6(hostname, { ttl: false })),
  ] as const;
  if (aborted) cancel();
  try {
    const results = await Promise.allSettled(operations);
    settled = true;
    if (aborted) throw new PushResolutionError("aborted");
    if (timedOut) throw new PushResolutionError("timeout");

    const addresses: string[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") addresses.push(...result.value);
      else if (!noData(result.reason)) throw new PushResolutionError("unavailable");
    }
    const selected = selectPermittedAddress(addresses);
    if (!selected) throw new PushResolutionError("unavailable");
    return selected;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    // allSettled above is the sole completion path; keeping this await in the
    // finally makes the settlement invariant explicit if later branches grow.
    await Promise.allSettled(operations);
    settled = true;
  }
}
