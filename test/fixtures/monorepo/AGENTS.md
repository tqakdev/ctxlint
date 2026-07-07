# Agent instructions — shopkit monorepo

pnpm workspace with two packages: `packages/api` (Fastify backend) and `packages/web`
(React storefront). Each package has its own AGENTS.md with package-specific rules;
this file covers what applies everywhere.

## Commands (run from the repo root)

- `pnpm install` — install for all packages
- `pnpm -r test` — run every package's tests
- `pnpm -r build` — build every package

## Repo-wide conventions

- TypeScript strict mode everywhere; no `any` outside test helpers.
- Cross-package imports go through the package's public entry point, never deep paths.
- Shared configuration lives at the repo root; packages must not carry their own
  lint or formatter configs.
- Commit messages follow conventional commits (`feat:`, `fix:`, `chore:`).
