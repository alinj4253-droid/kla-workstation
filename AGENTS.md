# Repository guidance

- Product source of truth: `docs/MVP_IMPLEMENTATION_SPEC.md`.
- Use pnpm workspaces. Run `pnpm typecheck`, `pnpm test`, and `pnpm build` before handoff.
- Renderer code must not import Node/Electron-only modules. All privileged capabilities go through the typed preload bridge.
- Keep `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`.
- Reuse design tokens from `apps/desktop/src/renderer/src/styles.css`; do not scatter new raw colors across components.
- Current UI is an explicit mock slice. Mock data lives in renderer files and must be replaced through contracts rather than coupled to future database code.
- Meetings and task center remain disabled in the MVP.
