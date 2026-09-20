import { describe, expect, it, vi } from "vitest";
import { PushNetworkError, PushResponseError, type ActivationOperation } from "../services/pushNotifications";
import { enrollmentFailureMessage, rollbackFailedEnrollment } from "./usePushNotifications";

const REJECTED = "The notification request was rejected. Refresh Draw and try again.";
const BROWSER_FAILURE = "Could not enable notifications in this browser. No device was enabled.";
const NETWORK_FAILURE = "Could not reach Draw. Check the connection and try again.";

function subscription(unsubscribe: () => Promise<boolean>): PushSubscription {
  return { unsubscribe } as PushSubscription;
}

function subscribeOperation(): ActivationOperation {
  return { kind: "subscribe", promise: Promise.resolve(subscription(() => Promise.resolve(true))) };
}

describe("Push enrollment failure boundary", () => {
  it("keeps invalid API success responses distinct from browser operation failures", () => {
    expect(enrollmentFailureMessage(new PushResponseError(), subscribeOperation())).toBe(REJECTED);
    expect(enrollmentFailureMessage(new PushNetworkError(), subscribeOperation())).toBe(NETWORK_FAILURE);
    expect(enrollmentFailureMessage(new Error("synthetic subscribe failure"), subscribeOperation())).toBe(BROWSER_FAILURE);
  });

  it("never rolls back a pre-existing matching subscription after enrollment rejection", async () => {
    const unsubscribe = vi.fn(() => Promise.resolve(true));
    await rollbackFailedEnrollment(subscription(unsubscribe), false);
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it("rolls back a subscription newly created by the explicit enrollment click", async () => {
    const unsubscribe = vi.fn(() => Promise.resolve(true));
    await rollbackFailedEnrollment(subscription(unsubscribe), true);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
