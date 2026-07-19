/**
 * The server's LOCAL calendar day — the one home of the "user day" concept.
 * Streaks and freeze milestones must never disagree about which day it is,
 * so the formatting rule lives here once instead of as drifting private
 * copies.
 *
 * Deliberately local (`getFullYear`/`getMonth`/`getDate`, never `getUTC*`):
 * "today" is the user's own calendar day, the same convention the streak's
 * SQLite `localtime` reads use. Everything else in the codebase is UTC —
 * user-day concepts are the documented exception.
 */
export function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
