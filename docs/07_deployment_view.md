# 7. Deployment View

[← back to index](index.md)

There is no production deployment — the application runs on the owner's machine.

```
Windows 11 PC
└── Node.js 22+ process tree (npm run dev → concurrently)
    ├── tsx watch server/src/index.ts     Express on :3001 (API_PORT)
    │     ├── server/data/app.db          SQLite (WAL mode)
    │     └── server/data/files/          uploaded goal materials
    └── vite                              client on :5173, /api proxied to :3001
```

| Aspect | Detail |
|---|---|
| Install | `npm install` (workspace root) |
| Run | `npm run dev`; browser at `http://localhost:5173` |
| Configuration | `server/.env`: `ANTHROPIC_API_KEY` (optional), `API_PORT` (default 3001). `PORT` is deliberately not used — dev tooling injects it |
| Data | Everything under `server/data/` (gitignored); backup = copy that folder |
| Docs hosting | GitHub Pages serves `docs/` from `main` (Jekyll, minimal theme) |

**Outbound network:** only `api.anthropic.com`, and only when an AI feature is
explicitly invoked with a configured key.
