import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../api/client";
import {
  STATUS_GUIDANCE,
  beginEnrollmentOperation,
  clearStoredHandle,
  deletePushDevice,
  enrollmentPrerequisites,
  fetchPushStatus,
  inspectBrowserPush,
  listedHandle,
  pushFailureMessage,
  registerPushSubscription,
  revokeAllPushDevices,
  samePrerequisites,
  sameSubscriptionData,
  sendPushTest,
  setPushPreference,
  snapshotFingerprint,
  storeHandle,
  subscriptionMatches,
  type ActivationOperation,
  type BrowserPushSnapshot,
  type EnrollmentPrerequisites,
  type PushStatus,
} from "../services/pushNotifications";

const LOAD_FAILURE = "Could not load deadline notification status. Check the connection and try again.";
const ENABLE_FAILURE = "Could not enable notifications in this browser. No device was enabled.";
const STORAGE_FAILURE = "Notifications were enabled, but Draw could not remember this browser. Re-enable after reloading.";
const CLEANUP_FAILURE = "The server device was removed, but browser cleanup could not be confirmed. Reload Draw and check browser site settings.";

interface Continuation {
  fingerprint: string;
  activeWorker: ServiceWorker;
}

async function loadSnapshots(): Promise<{ status: PushStatus; browser: BrowserPushSnapshot }> {
  const [status, browser] = await Promise.all([fetchPushStatus(), inspectBrowserPush()]);
  return { status, browser };
}

function errorCode(error: unknown): { status: number; code: string } | null {
  if (!(error instanceof ApiError)) return null;
  const code = (error.body as { error?: unknown } | undefined)?.error;
  return { status: error.status, code: typeof code === "string" ? code : error.message };
}

export function usePushNotifications() {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [browser, setBrowser] = useState<BrowserPushSnapshot | null>(null);
  const [checking, setChecking] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [continuation, setContinuation] = useState<Continuation | null>(null);
  const mounted = useRef(true);
  const pendingRef = useRef(false);
  const statusRef = useRef(status);
  const browserRef = useRef(browser);
  // A successful server enrollment whose localStorage write fails remains
  // identifiable for this mounted Settings view only. Reload deliberately
  // loses it and returns to Re-enable, as the closed failure contract says.
  const volatileHandleRef = useRef<string | null>(null);

  const applySnapshots = useCallback((next: { status: PushStatus; browser: BrowserPushSnapshot }) => {
    const effectiveBrowser = volatileHandleRef.current && next.status.devices.some((device) => device.id === volatileHandleRef.current)
      ? { ...next.browser, handle: volatileHandleRef.current }
      : next.browser;
    statusRef.current = next.status;
    browserRef.current = effectiveBrowser;
    if (!mounted.current) return;
    setStatus(next.status);
    setBrowser(effectiveBrowser);
    setChecking(false);
    setLoadError(false);
  }, []);

  const refresh = useCallback(async (
    clearMessage = true,
    preserveLoadedStatus = false,
  ): Promise<{ status: PushStatus; browser: BrowserPushSnapshot } | null> => {
    if (clearMessage && mounted.current) setMessage(null);
    try {
      const next = await loadSnapshots();
      applySnapshots(next);
      return next;
    } catch {
      if (mounted.current) {
        setChecking(false);
        if (!preserveLoadedStatus || statusRef.current === null) setLoadError(true);
      }
      return null;
    }
  }, [applySnapshots]);

  useEffect(() => {
    mounted.current = true;
    void refresh(false);
    return () => { mounted.current = false; };
  }, [refresh]);

  const prerequisites = useMemo(() => enrollmentPrerequisites(status, browser), [status, browser]);
  const continuationValid = continuation !== null && prerequisites !== null &&
    continuation.fingerprint === snapshotFingerprint(prerequisites) &&
    continuation.activeWorker === prerequisites.browser.activeWorker;

  useEffect(() => {
    if (continuation !== null && !continuationValid) setContinuation(null);
  }, [continuation, continuationValid]);

  const setBusy = (value: boolean) => {
    pendingRef.current = value;
    if (mounted.current) setPending(value);
  };

  // Inspection and refresh are deliberately read-only. A malformed handle, or
  // a canonical handle that an available server status proves is no longer
  // listed, is forgotten only when the owner starts an explicit mutation.
  // The in-memory snapshot is sanitized even when best-effort storage cleanup
  // fails, so a stale id is never sent as replaceDeviceId.
  const prepareLocalHandleForMutation = useCallback((): BrowserPushSnapshot | null => {
    const current = browserRef.current;
    const currentStatus = statusRef.current;
    if (!current) return null;
    const confirmedStale = current.handle !== null && currentStatus?.available === true &&
      !currentStatus.devices.some((device) => device.id === current.handle);
    if (!current.malformedHandle && !confirmedStale) return current;
    if (current.malformedHandle) clearStoredHandle();
    else clearStoredHandle(current.handle);
    const sanitized = { ...current, handle: null, malformedHandle: false };
    browserRef.current = sanitized;
    if (mounted.current) setBrowser(sanitized);
    return sanitized;
  }, []);

  const finishEnrollment = useCallback(async (
    captured: EnrollmentPrerequisites,
    operation: ActivationOperation | null,
    wasContinuation: boolean,
  ) => {
    // Keep the identity captured at the explicit mutation boundary. Snapshot
    // reloads validate current status, worker, permission, and subscription,
    // but localStorage remains untrusted after best-effort stale cleanup.
    const capturedHandle = captured.browser.handle;
    let newlyCreated: PushSubscription | null = null;
    try {
      if (operation?.kind === "permission") {
        const permission = await operation.promise;
        if (!mounted.current) return;
        const next = await loadSnapshots();
        if (!samePrerequisites(captured, enrollmentPrerequisites(next.status, next.browser), true)) {
          setContinuation(null);
          applySnapshots(next);
          return;
        }
        applySnapshots(next);
        if (permission !== "granted") return;
        const current = enrollmentPrerequisites(next.status, next.browser);
        if (!current) return;
        if (!current.browser.subscription) {
          setContinuation({
            fingerprint: snapshotFingerprint(current),
            activeWorker: current.browser.activeWorker!,
          });
          return;
        }
        if (!subscriptionMatches(current.browser.subscription, current.vapidBytes)) return;
        captured = current;
      } else if (operation?.kind === "unsubscribe") {
        const removed = await operation.promise;
        if (!removed || !mounted.current) throw new Error("unsubscribe failed");
        const next = await loadSnapshots();
        const current = enrollmentPrerequisites(next.status, next.browser);
        applySnapshots(next);
        if (!samePrerequisites(captured, current) || !current || current.browser.subscription !== null) {
          setContinuation(null);
          return;
        }
        setContinuation({
          fingerprint: snapshotFingerprint(current),
          activeWorker: current.browser.activeWorker!,
        });
        return;
      } else if (operation?.kind === "subscribe") {
        newlyCreated = await operation.promise;
        if (!mounted.current) {
          await newlyCreated.unsubscribe().catch(() => false);
          return;
        }
        const next = await loadSnapshots();
        const current = enrollmentPrerequisites(next.status, next.browser);
        applySnapshots(next);
        if (!samePrerequisites(captured, current) || !current ||
          !current.browser.subscription ||
          !sameSubscriptionData(current.browser.subscription, newlyCreated) ||
          !subscriptionMatches(current.browser.subscription, current.vapidBytes)) {
          await newlyCreated.unsubscribe().catch(() => false);
          setContinuation(null);
          return;
        }
        captured = current;
      } else {
        // Matching-subscription reuse has no activation-sensitive operation.
        const next = await loadSnapshots();
        const current = enrollmentPrerequisites(next.status, next.browser);
        applySnapshots(next);
        if (!samePrerequisites(captured, current) || !current || !current.browser.subscription ||
          !subscriptionMatches(current.browser.subscription, current.vapidBytes)) {
          setContinuation(null);
          return;
        }
        captured = current;
      }

      const subscription = newlyCreated ?? captured.browser.subscription;
      if (!subscription) {
        if (wasContinuation && mounted.current) setContinuation(null);
        return;
      }
      const device = await registerPushSubscription(subscription, capturedHandle);
      if (!mounted.current) return;
      setContinuation(null);
      if (!storeHandle(device.id)) {
        volatileHandleRef.current = device.id;
        setMessage(STORAGE_FAILURE);
      } else {
        volatileHandleRef.current = null;
        setMessage("Notifications are enabled for this browser.");
      }
      await refresh(false);
    } catch (error) {
      if (newlyCreated !== null) await newlyCreated.unsubscribe().catch(() => false);
      if (mounted.current) {
        setContinuation(null);
        await refresh(false);
        const closed = errorCode(error);
        if (closed?.status === 403 && statusRef.current?.mutationReason) {
          setMessage(STATUS_GUIDANCE[statusRef.current.mutationReason]);
        } else if (closed?.status === 503 && statusRef.current?.reason) {
          setMessage(STATUS_GUIDANCE[statusRef.current.reason]);
        } else {
          setMessage(operation && (operation.kind === "permission" || operation.kind === "unsubscribe" || operation.kind === "subscribe") && !(error instanceof ApiError)
            ? ENABLE_FAILURE
            : pushFailureMessage(error, "enroll"));
        }
      }
    } finally {
      setBusy(false);
    }
  }, [applySnapshots, refresh]);

  /** Direct button handler: performs its one browser operation before any await. */
  const enroll = useCallback(() => {
    if (pendingRef.current) return;
    const preparedBrowser = prepareLocalHandleForMutation();
    const captured = enrollmentPrerequisites(statusRef.current, preparedBrowser);
    if (!captured) {
      setContinuation(null);
      return;
    }
    const continuing = continuation !== null &&
      continuation.fingerprint === snapshotFingerprint(captured) &&
      continuation.activeWorker === captured.browser.activeWorker;
    if (continuation !== null && !continuing) {
      setContinuation(null);
      return;
    }
    // Recheck every synchronously observable prerequisite immediately before
    // starting the activation-sensitive call.
    const activeImmediatelyBeforeOperation = captured.browser.registration?.active ?? null;
    if (captured.browser.permission !== (typeof Notification === "undefined" ? "unavailable" : Notification.permission) ||
      activeImmediatelyBeforeOperation !== captured.browser.activeWorker ||
      activeImmediatelyBeforeOperation?.state !== "activated" ||
      activeImmediatelyBeforeOperation.scriptURL !== new URL("/sw.js", location.origin).href) {
      setContinuation(null);
      return;
    }
    setBusy(true);
    setMessage(null);
    const operation = beginEnrollmentOperation(captured, continuing);
    void finishEnrollment(captured, operation, continuing);
  }, [continuation, finishEnrollment, prepareLocalHandleForMutation]);

  const runMutation = useCallback(async (work: () => Promise<void>, context: "test" | "mutation") => {
    if (pendingRef.current) return;
    prepareLocalHandleForMutation();
    setBusy(true);
    setMessage(null);
    try { await work(); }
    catch (error) {
      if (mounted.current) {
        const closed = errorCode(error);
        if (closed?.status === 403 && statusRef.current?.mutationReason) {
          setMessage(STATUS_GUIDANCE[statusRef.current.mutationReason]);
        } else if (closed?.status === 503 && statusRef.current?.reason) {
          setMessage(STATUS_GUIDANCE[statusRef.current.reason]);
        } else setMessage(pushFailureMessage(error, context));
      }
    } finally { setBusy(false); }
  }, [prepareLocalHandleForMutation]);

  const updatePreference = useCallback((hideDetails: boolean) => {
    void runMutation(async () => {
      try {
        const accepted = await setPushPreference(hideDetails);
        const current = statusRef.current;
        if (current) {
          const adopted = { ...current, preferences: { hideDetails: accepted } };
          statusRef.current = adopted;
          if (mounted.current) setStatus(adopted);
        }
        const refreshed = await refresh(false, true);
        if (!refreshed && mounted.current) setMessage(LOAD_FAILURE);
      } catch (error) {
        await refresh(false, true);
        const closed = errorCode(error);
        if (closed?.status === 403 && statusRef.current?.mutationReason) {
          setMessage(STATUS_GUIDANCE[statusRef.current.mutationReason]);
        } else if (closed?.status === 503 && statusRef.current?.reason) {
          setMessage(STATUS_GUIDANCE[statusRef.current.reason]);
        } else throw error;
      }
    }, "mutation");
  }, [refresh, runMutation]);

  const revokeDevice = useCallback((deviceId: string) => {
    void runMutation(async () => {
      try {
        await deletePushDevice(deviceId);
      } catch (error) {
        await refresh(false);
        throw error;
      }
      const local = browserRef.current?.handle === deviceId;
      if (local) {
        const subscription = browserRef.current?.subscription;
        const cleaned = subscription ? await subscription.unsubscribe().catch(() => false) : true;
        const cleared = clearStoredHandle(deviceId);
        volatileHandleRef.current = null;
        if (!cleaned || !cleared) setMessage(CLEANUP_FAILURE);
      }
      await refresh(false);
    }, "mutation");
  }, [refresh, runMutation]);

  const revokeAll = useCallback(() => {
    void runMutation(async () => {
      const localId = browserRef.current?.handle ?? null;
      try {
        await revokeAllPushDevices();
      } catch (error) {
        const next = await refresh(false);
        if (localId && next && !next.status.devices.some((device) => device.id === localId)) {
          const cleaned = next.browser.subscription ? await next.browser.subscription.unsubscribe().catch(() => false) : true;
          const cleared = clearStoredHandle(localId);
          volatileHandleRef.current = null;
          await refresh(false);
          if (!cleaned || !cleared) {
            setMessage(CLEANUP_FAILURE);
            return;
          }
          throw error;
        }
        throw error;
      }
      const subscription = browserRef.current?.subscription;
      const cleaned = subscription ? await subscription.unsubscribe().catch(() => false) : true;
      const cleared = clearStoredHandle();
      volatileHandleRef.current = null;
      if (!cleaned || !cleared) setMessage(CLEANUP_FAILURE);
      await refresh(false);
    }, "mutation");
  }, [refresh, runMutation]);

  const testDevice = useCallback((deviceId: string) => {
    void runMutation(async () => {
      try {
        await sendPushTest(deviceId);
        if (mounted.current) setMessage("Test request accepted; delivery is best effort.");
      } catch (error) {
        const closed = errorCode(error);
        if (closed && (
          closed.status === 403 || closed.status === 404 || closed.status === 410 ||
          closed.code === "push-test-cancelled" || closed.code === "push-recovery-pending" || closed.code === "push-unavailable"
        )) {
          const next = await refresh(false);
          if (next && (closed.status === 404 || closed.status === 410) && next.browser.handle === deviceId) {
            clearStoredHandle(deviceId);
            volatileHandleRef.current = null;
            await refresh(false);
          }
          if (closed.status === 403 && statusRef.current?.mutationReason) {
            setMessage(STATUS_GUIDANCE[statusRef.current.mutationReason]);
            return;
          }
          if ((closed.code === "push-recovery-pending" || closed.code === "push-unavailable") && statusRef.current?.reason) {
            setMessage(STATUS_GUIDANCE[statusRef.current.reason]);
            return;
          }
        }
        throw error;
      }
    }, "test");
  }, [refresh, runMutation]);

  const matchingHandle = status && browser ? listedHandle(status, browser.handle) : null;
  const matchingSubscription = prerequisites
    ? subscriptionMatches(prerequisites.browser.subscription, prerequisites.vapidBytes)
    : false;
  const enabled = matchingSubscription && matchingHandle !== null;
  const enrollmentLabel = continuationValid
    ? "Continue enabling"
    : browser?.subscription && (!prerequisites || !matchingSubscription) || matchingSubscription && matchingHandle === null
      ? "Re-enable"
      : "Enable";

  return {
    status,
    browser,
    checking,
    loadError,
    pending,
    message,
    prerequisites,
    enabled,
    matchingHandle,
    enrollmentLabel,
    enroll,
    refresh: () => void refresh(),
    updatePreference,
    revokeDevice,
    revokeAll,
    testDevice,
    loadFailureMessage: LOAD_FAILURE,
  };
}
