import { beforeEach, describe, expect, it, vi } from "vitest";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { regenerateCardArtMutation } from "./useAi";
import { api } from "../api/client";

// The mutation options are exercised through query-core's own
// MutationObserver — the exact machinery useMutation drives — so the test
// covers real re-render semantics (setOptions on a PENDING mutation) without
// needing a DOM. Only the HTTP layer is mocked.
vi.mock("../api/client", () => ({
  api: { post: vi.fn() },
}));
const postMock = vi.mocked(api.post);

// Regression pin for the PR #119 review finding on #113: React Query v5
// replaces a pending mutation's options on every re-render, so an id captured
// in the onSuccess CLOSURE is late-bound — a regenerate resolving after the
// drawn task changed (↻ on task A → complete → draw task B) would write A's
// art under B's ["card-art", B] key, frozen for the session by
// staleTime: Infinity. The id must therefore travel as the mutation variable.
describe("regenerateCardArtMutation (#113)", () => {
  beforeEach(() => {
    postMock.mockReset();
  });

  it("POSTs to the task given at mutate() time and caches under that same id", async () => {
    const qc = new QueryClient();
    const observer = new MutationObserver(qc, regenerateCardArtMutation(qc));
    postMock.mockResolvedValueOnce({ svg: "<svg>seven</svg>" });

    await observer.mutate(7);

    expect(postMock).toHaveBeenCalledExactlyOnceWith("/api/tasks/7/card-art/regenerate");
    expect(qc.getQueryData(["card-art", 7])).toEqual({ svg: "<svg>seven</svg>" });
  });

  it("keeps the cache write pinned to the mutated task across mid-flight re-renders", async () => {
    const qc = new QueryClient();
    const observer = new MutationObserver(qc, regenerateCardArtMutation(qc));

    // Hold the POST so the "drawn task changed" re-render happens while the
    // regenerate is still in flight — the buggy shape resolved AFTER this.
    let release!: (data: { svg: string }) => void;
    postMock.mockImplementationOnce(
      () => new Promise<{ svg: string }>((resolve) => (release = resolve)),
    );

    const inFlight = observer.mutate(7); // regenerate task 7…
    // mutation.execute reaches the mutationFn asynchronously — wait until the
    // POST is genuinely in flight before "re-rendering".
    await vi.waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    // …then the user completes it and draws task 8: every re-render replaces
    // the pending mutation's options (query-core setOptions — the late-binding
    // the fixed shape must be immune to).
    observer.setOptions(regenerateCardArtMutation(qc));

    release({ svg: "<svg>seven</svg>" });
    await inFlight;

    // The art lands under task 7 — never under the newly drawn card's key.
    expect(qc.getQueryData(["card-art", 7])).toEqual({ svg: "<svg>seven</svg>" });
    expect(qc.getQueryData(["card-art", 8])).toBeUndefined();
    expect(postMock).toHaveBeenCalledExactlyOnceWith("/api/tasks/7/card-art/regenerate");
  });
});
