# 8. Cross-cutting Concepts

[← back to index](index.md)

## 8.1 Derived state over stored state

Anything that can drift is computed at read time: drawability (SQL predicate),
"in progress" (running time entry exists), XP/level/streak (aggregates over
`completions`), weekly grade (aggregation over `time_entries`). Only facts are
stored (tasks, entries, completions, unlocked achievements).

## 8.2 The weight formula

```
weight = impact² / max(effort, 5)          leverage per minute
       × urgency(due_date)                 ×1 → ×4 over last 7 days, ×5 overdue
       × staleness(created/last_completed) up to ×2 over 30 days
       × 0.15 if drawn within cooldown     variety on "draw again"
```

Household chores work without ratings: no goal → neutral impact 3, and staleness
makes neglected chores progressively louder.

## 8.3 Error handling

- Server: consistent `{error: string}` bodies with proper status codes (404, 409 for
  domain conflicts, 503 for unconfigured AI).
- Client: typed `ApiError` from a single fetch wrapper; TanStack Query retry once.
- AI: SDK's typed exception classes mapped most-specific-first
  (`AuthenticationError` → friendly key hint, `RateLimitError` → 429,
  `APIConnectionError` → offline hint).

## 8.4 AI usage rules

Server-side only. `claude-opus-4-8` with adaptive thinking and structured outputs
(`messages.parse` + `zodOutputFormat`; impact as literal union 1|2|3|4|5 because
numeric min/max is unsupported). Materials precede instructions in the prompt with a
`cache_control` breakpoint on the last material block (prompt caching). Token
counting gates every call (estimate endpoint + 180K hard limit). No `temperature`,
`budget_tokens`, or assistant prefill — all rejected by this model family.

## 8.5 Security

- API key only in `server/.env` (gitignored), never in the browser.
- Upload filenames sanitized; stored under server-generated names; download/delete
  paths resolved and verified against the files directory (no traversal).
- Upload restricted to PDF/txt/md, 50 MB cap.
- App binds to localhost; no auth by design (single local user).

## 8.6 Time handling

Timestamps stored as ISO 8601 UTC strings. Date-only values (due dates) are
compared as strings. Date-range arithmetic happens in UTC (`addDays` in
`routes/stats.ts`) — local-timezone `Date` round-trips caused an off-by-one-day bug
(see [section 11](11_risks_and_technical_debt.md)). Streak days use SQLite
`date(..., 'localtime')` because a "day" is a user-local concept.

## 8.7 Database migrations

`PRAGMA user_version` switch in `db.ts`: fresh databases execute `schema.sql`
(always the current schema); existing databases run incremental `ALTER TABLE`
steps. No migration framework.
