/// <reference types="vite/client" />

// Pulls in Vite's ambient module declarations so static asset imports type-check
// under `tsc --noEmit` — `import art from "./x.svg"` is a string URL that Vite
// fingerprints into the bundle (issue #124's committed achievement art is the
// first asset import in this client).
