import { STATUS_GUIDANCE } from "../services/pushNotifications";
import { usePushNotifications } from "../hooks/usePushNotifications";

function LocalTime({ value }: { value: string }) {
  const date = new Date(value);
  return <time dateTime={value}>{date.toLocaleString()}</time>;
}

export function PushNotificationsSection() {
  const push = usePushNotifications();
  const { status, browser } = push;
  const serverControls = status?.available === true && status.mutationAllowed;
  const blockers: string[] = [];

  if (browser) {
    if (!browser.secureContext) blockers.push("Deadline notifications require HTTPS, or direct localhost access.");
    if (!browser.registration) blockers.push("The Draw service worker is not available in this browser. Reload the production app and try again.");
    if (!browser.hasPushManager) blockers.push("This browser does not support Web Push.");
    if (!browser.hasNotification) blockers.push("This browser does not support notifications.");
    if (browser.permission === "denied") blockers.push("Notifications are blocked for this site. Allow them in browser settings, then reload Draw.");
  }
  if (status?.reason) blockers.push(STATUS_GUIDANCE[status.reason]);
  if (status?.mutationReason) blockers.push(STATUS_GUIDANCE[status.mutationReason]);

  return (
    <section className="panel push-notifications" style={{ display: "grid", gap: 12, marginTop: 16 }}>
      <h3 style={{ margin: 0 }}>Deadline notifications</h3>
      {push.checking ? (
        <p style={{ margin: 0, color: "var(--text-dim)" }}>Checking notification support...</p>
      ) : push.loadError ? (
        <div role="alert" className="push-message push-error">
          <span>{push.loadFailureMessage}</span>
          <button type="button" disabled={push.pending} onClick={push.refresh}>Retry</button>
        </div>
      ) : (
        <>
          {blockers.map((blocker) => <p key={blocker} className="push-guidance">{blocker}</p>)}
          {push.enabled ? (
            <p style={{ margin: 0, color: "var(--ok)" }}>✓ Notifications are enabled for this browser.</p>
          ) : push.prerequisites ? (
            <div className="push-actions">
              <button type="button" className="primary" disabled={push.pending} onClick={push.enroll}>
                {push.enrollmentLabel}
              </button>
              <span style={{ color: "var(--text-dim)", fontSize: 13 }}>
                Enabling is explicit. Delivery is best effort while Draw runs.
              </span>
            </div>
          ) : null}

          {status && (
            <>
              <label className="push-preference">
                <input
                  type="checkbox"
                  checked={status.preferences.hideDetails}
                  disabled={!serverControls || push.pending}
                  onChange={(event) => push.updatePreference(event.target.checked)}
                />
                <span>
                  <strong>Hide notification details</strong>
                  <small>Applies to future deadline notifications on every enrolled device. When enabled, they say only &quot;You have an upcoming deadline in Draw&quot;. Test notifications are unchanged.</small>
                </span>
              </label>

              <div className="push-device-list" aria-label="Enrolled notification devices">
                {status.devices.length === 0 ? (
                  <p style={{ margin: 0, color: "var(--text-dim)" }}>No notification devices are enrolled.</p>
                ) : status.devices.map((device) => {
                  const local = device.id === push.matchingHandle;
                  return (
                    <article className="push-device" key={device.id}>
                      <div className="push-device-meta">
                        <strong>{local ? "This device" : "Other device"}</strong>
                        <span>Added <LocalTime value={device.createdAt} /></span>
                        <span>Last seen <LocalTime value={device.lastSeenAt} /></span>
                      </div>
                      <div className="push-actions">
                        <button type="button" disabled={!serverControls || push.pending} onClick={() => push.testDevice(device.id)}>
                          Send test
                        </button>
                        <button type="button" disabled={!serverControls || push.pending} onClick={() => push.revokeDevice(device.id)}>
                          {local ? "Disable this device" : "Revoke"}
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>

              <div className="push-actions">
                <button type="button" disabled={!serverControls || push.pending || status.devices.length === 0} onClick={push.revokeAll}>
                  Revoke all devices
                </button>
              </div>
            </>
          )}
        </>
      )}
      <div role="status" className="push-message" aria-live="polite">{push.message}</div>
    </section>
  );
}
