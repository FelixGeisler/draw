import { useEffect, useState, type FormEvent } from "react";
import { STATUS_GUIDANCE, type PushTiming } from "../services/pushNotifications";
import { usePushNotifications } from "../hooks/usePushNotifications";

function LocalTime({ value }: { value: string }) {
  const date = new Date(value);
  return <time dateTime={value}>{date.toLocaleString()}</time>;
}

const TIMING_ERROR = "Check the reminder timing and time zone. No settings were changed.";

function proposedTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; }
}

function validTiming(timing: PushTiming, quietEnabled: boolean): timing is PushTiming & { timezone: string } {
  const quarter = (value: string | null) => typeof value === "string" && /^(?:[01]\d|2[0-3]):(?:00|15|30|45)$/.test(value);
  if (!quarter(timing.sendTime) || typeof timing.timezone !== "string" || timing.timezone.length < 1 ||
    timing.timezone.length > 128 || [...timing.timezone].some((character) => character.charCodeAt(0) > 0x7f)) return false;
  try { new Intl.DateTimeFormat("en-CA", { timeZone: timing.timezone }).format(0); } catch { return false; }
  return quietEnabled
    ? quarter(timing.quietStart) && quarter(timing.quietEnd) && timing.quietStart !== timing.quietEnd
    : timing.quietStart === null && timing.quietEnd === null;
}

export function PushNotificationsSection() {
  const push = usePushNotifications();
  const { status, browser } = push;
  const [timing, setTiming] = useState<PushTiming | null>(null);
  const [quietEnabled, setQuietEnabled] = useState(false);
  const [timingError, setTimingError] = useState<string | null>(null);
  const serverControls = status?.available === true && status.mutationAllowed;
  const blockers: string[] = [];

  useEffect(() => {
    if (!status) return;
    const saved = status.preferences;
    setTiming({
      leadDays: saved.leadDays,
      sendTime: saved.sendTime,
      timezone: saved.timezone ?? proposedTimeZone(),
      quietStart: saved.quietStart,
      quietEnd: saved.quietEnd,
    });
    setQuietEnabled(saved.quietStart !== null && saved.quietEnd !== null);
  }, [status?.preferences.leadDays, status?.preferences.sendTime, status?.preferences.timezone,
    status?.preferences.quietStart, status?.preferences.quietEnd]);

  const submitTiming = (event: FormEvent) => {
    event.preventDefault();
    if (!timing || !validTiming(timing, quietEnabled)) {
      setTimingError(TIMING_ERROR);
      if (status) {
        setTiming({
          leadDays: status.preferences.leadDays,
          sendTime: status.preferences.sendTime,
          timezone: status.preferences.timezone ?? proposedTimeZone(),
          quietStart: status.preferences.quietStart,
          quietEnd: status.preferences.quietEnd,
        });
        setQuietEnabled(status.preferences.quietStart !== null && status.preferences.quietEnd !== null);
      }
      return;
    }
    setTimingError(null);
    push.updateTiming(timing);
  };

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

              {timing && (
                <form className="push-timing" onSubmit={submitTiming} noValidate>
                  <h4>Reminder timing</h4>
                  <label>
                    <span>Remind me</span>
                    <select
                      value={timing.leadDays}
                      disabled={!serverControls || push.pending}
                      onChange={(event) => setTiming({ ...timing, leadDays: Number(event.target.value) as PushTiming["leadDays"] })}
                    >
                      <option value={0}>On the deadline</option>
                      {[1, 2, 3, 7, 14, 30].map((days) => <option key={days} value={days}>{days} day{days === 1 ? "" : "s"} before</option>)}
                    </select>
                  </label>
                  <label>
                    <span>Send time</span>
                    <input type="time" step={900} value={timing.sendTime} disabled={!serverControls || push.pending}
                      onChange={(event) => setTiming({ ...timing, sendTime: event.target.value })} />
                  </label>
                  <label>
                    <span>Time zone (IANA)</span>
                    <input type="text" value={timing.timezone ?? ""} maxLength={128} autoCapitalize="none" spellCheck={false}
                      disabled={!serverControls || push.pending}
                      onChange={(event) => setTiming({ ...timing, timezone: event.target.value })} />
                  </label>
                  <label className="push-preference">
                    <input type="checkbox" checked={quietEnabled} disabled={!serverControls || push.pending}
                      onChange={(event) => {
                        const enabled = event.target.checked;
                        setQuietEnabled(enabled);
                        setTiming({ ...timing, quietStart: enabled ? timing.quietStart ?? "22:00" : null,
                          quietEnd: enabled ? timing.quietEnd ?? "08:00" : null });
                      }} />
                    <span><strong>Quiet hours</strong></span>
                  </label>
                  {quietEnabled && (
                    <div className="push-quiet-hours">
                      <label><span>Start</span><input type="time" step={900} value={timing.quietStart ?? "22:00"}
                        disabled={!serverControls || push.pending}
                        onChange={(event) => setTiming({ ...timing, quietStart: event.target.value })} /></label>
                      <label><span>End</span><input type="time" step={900} value={timing.quietEnd ?? "08:00"}
                        disabled={!serverControls || push.pending}
                        onChange={(event) => setTiming({ ...timing, quietEnd: event.target.value })} /></label>
                    </div>
                  )}
                  <button type="submit" disabled={!serverControls || push.pending}>Save reminder timing</button>
                  {timingError && <p role="alert" className="push-guidance">{timingError}</p>}
                </form>
              )}

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
