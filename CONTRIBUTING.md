# Contributing to KLA Workstation

Thanks for your interest in contributing! This document covers the essentials.

## Branch model

- `main` is the integration branch for the next release.
- New versions live on version branches (e.g. `feature/kla-workstation`);
  old desktop-only code stays on `main` / `chat` — do not port legacy
  desktop modules back into the new client/server split.
- Open a feature branch from the appropriate base and keep commits
  small and described (`feat:`, `fix:`, `docs:`, `chore:` …).

## Pre-merge gate

Every contribution must pass the full local gate before review:

```bash
pnpm ci-check    # typecheck + lint + test + build
```

- `pnpm typecheck` — TypeScript across all packages
- `pnpm lint` — ESLint
- `pnpm test` — Vitest unit + integration tests (server integration tests
  run automatically when `DATABASE_URL` is set, and skip otherwise)
- `pnpm build` — build all packages

CI runs the same gate on GitHub Actions and GitLab CI.

## API contracts

Business API definitions live in `docs/FULL_STACK_IMPLEMENTATION_SPEC.md` §6,
and machine-readable contracts in `packages/contracts`. Follow the freeze
and change process in [API_CONTRACTS.md](docs/API_CONTRACTS.md): contract
changes require a spec update first, then a coordinated client + server
release.

## Architecture boundaries

- **Renderer** (`apps/desktop/src`): React + Vite. It must not access the
  database, filesystem, model keys, or external compute services. All
  server data goes through the typed HTTP clients in `apps/desktop/src/api/`.
- **Electron shell** (`apps/desktop/desktop/`): window + typed Preload only.
  `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` stay
  mandatory.
- **Server** (`server/`): authoritative source for accounts, identities,
  permissions, knowledge, long-term memory, and role definitions. The client
  only caches and drafts.

Do not reintroduce the legacy `window.kunqing` bridge in new code; the
migration target is the HTTP/SSE contract in `apps/desktop/src/api/`.

## Dependencies

This is a pnpm workspace. Add dependencies to the owning package's
`package.json`, then run `pnpm install`. Never commit `package-lock.json`.

## Commit messages

Conventional commits with a short summary in Chinese or English are both
fine. Reference related issues/plans when applicable.
