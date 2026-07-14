# 3. Context and Scope

[← back to index](index.md)

## 3.1 Business Context

```
                 ┌──────────────────────────────┐
   uses browser  │            Draw              │   HTTPS (only when
  ┌──────────┐   │  ┌────────┐    ┌──────────┐  │   AI is used)
  │   User   │◄──┼─►│ Client │◄──►│  Server  │◄─┼──────────► Anthropic
  └──────────┘   │  │ (Vite/ │    │(Express+ │  │            Claude API
                 │  │ React) │    │ SQLite)  │  │
                 │  └────────┘    └──────────┘  │
                 └──────────────────────────────┘
                        localhost only
```

| Partner | Input | Output |
|---|---|---|
| **User** | Tasks, goals, estimates, impact ratings, uploaded materials (PDF/txt/md), draw/timer/completion actions | Drawn cards, stats, leverage insights, XP/achievements, AI suggestions |
| **Anthropic Claude API** | Task/goal context + selected materials (as document blocks), structured-output schema | Subtask suggestions, backward-planning analysis, token counts (for cost estimates) |

## 3.2 Technical Context

| Channel | Protocol | Description |
|---|---|---|
| Browser ↔ Vite dev server | HTTP :5173 | UI delivery + HMR |
| Browser ↔ Express | HTTP :5173 → proxy → :3001 | JSON REST under `/api/*`; multipart for material upload |
| Express ↔ SQLite | in-process (better-sqlite3) | Synchronous queries, WAL mode |
| Express ↔ Claude API | HTTPS | `@anthropic-ai/sdk`; only for `/api/ai/*` endpoints |
| Express ↔ file system | `server/data/files/` | Uploaded goal materials |

**Scope boundaries:** no mobile app, no multi-device sync, no calendar integration,
no notifications. The Claude API is the only external system.
