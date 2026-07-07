# packages/api

Fastify backend. Exposes the storefront REST API.

- Entry point is `src/index.ts`; route plugins register there.
- Every route declares a JSON schema for its body and reply — Fastify validates
  automatically, so handlers can trust their input.
- Database access only through the repository layer; handlers never import `pg`.
- Run `pnpm --filter api test` from the repo root for just this package's tests.
