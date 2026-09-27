# Repository guidance

- Current architecture and runtime boundaries: `docs/ARCHITECTURE.md`.
- Historical MVP requirements and acceptance baseline: `docs/MVP_IMPLEMENTATION_SPEC.md`.
- Use pnpm workspaces. Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build` before handoff.
- better-sqlite3 must be rebuilt for the target Node ABI. Before `pnpm test`, run `node-gyp rebuild` (system Node). Before `pnpm build`/`pnpm dev`, run `electron-rebuild` (Electron). The desktop `build`/`dev` scripts handle electron-rebuild automatically; tests require the manual `node-gyp rebuild` step.
- Renderer code must not import Node/Electron-only modules. All privileged capabilities go through the typed preload bridge.
- Keep `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`.
- Reuse design tokens from `apps/desktop/src/renderer/src/styles.css`; do not scatter new raw colors across components.
- Current UI contains both persisted flows and explicitly marked mock data. Mock data lives in renderer files and must be replaced through contracts rather than coupled to future database code.
- Historical MVP documents describe an earlier feature boundary; current page availability is controlled by the implementation and feature settings.
- CI/E2E/visual-regression are deferred to post-MVP. Local equivalents: `pnpm ci-check` (typecheck + lint + test + build), `pnpm test:e2e` (build artifact verification).
- TypeScript 7 used for project; eslint uses `@typescript-eslint/parser` which does not support TS 7 — TS 6 is used at workspace root for lint compatibility only.
