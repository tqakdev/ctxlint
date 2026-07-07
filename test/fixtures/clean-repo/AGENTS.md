# Agent instructions — orderflow

REST service for order intake. TypeScript, Fastify, Postgres.

## Commands

- `npm run build` — compile to `dist/`
- `npm test` — run the vitest suite; must pass before any commit
- `npm run lint` — biome check; fix warnings before opening a PR

## Architecture

- `src/index.ts` — entry point; wires config and starts the server
- `src/server.ts` — route definitions; one handler per route, no business logic inline
- `src/lib/db.ts` — the only file allowed to talk to Postgres; everything else goes through its exported repository functions
- `src/lib/validate.ts` — request-body schemas; every route handler validates input here before touching the database

## Conventions

- Use 2-space indentation and double quotes; biome enforces this.
- Never log request bodies — they can contain customer PII.
- Return errors as `{ error: { code, message } }`; never leak stack traces to clients.
- New environment variables must be added to `.env.example` with a comment.

## Testing

- Unit tests live next to the file they test as `*.test.ts`.
- Use the fake repository from `src/lib/db.ts` (`createFakeRepo`) instead of mocking Postgres.
