# @kunqing/desktop

Electron desktop application for KLA Workstation. The package is private and is
started from the workspace root; it is not published as an npm library.

## Development

Run these commands from the repository root:

```bash
pnpm dev       # Electron desktop preview
pnpm dev:web   # Renderer-only browser preview
pnpm typecheck # Node and renderer TypeScript checks
pnpm test      # Vitest tests (rebuilds better-sqlite3 first)
pnpm build     # Electron production build
```

The renderer communicates with privileged desktop capabilities through the
typed preload bridge in `src/preload/index.ts`. Main-process code must not be
imported by renderer modules.
