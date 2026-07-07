# CLAUDE.md — acme-orders

This file tells Claude how to work in the acme-orders service. It has grown over time;
read the whole thing before making changes.

## Project overview

acme-orders is the order intake service for the Acme storefront. It receives orders from
the web checkout and the partner API, validates them, prices them, and writes them to
Postgres. Downstream services (fulfillment, invoicing, analytics) consume the
`orders.created` events we publish. It is a plain Express app — no framework magic — and
we intend to keep it that way. The service is deployed as a single container behind the
shared ALB, scaled horizontally; there is no in-process state, so any instance can serve
any request.

The service is old (started 2019) and carries some historical weight. When something
looks strange, check `docs/architecture.md` for the reasoning before "fixing" it.

## Getting started

- Node 18 or newer. We do not use pnpm or yarn here; plain npm only.
- `npm install`, then copy `.env.example` to `.env` and fill in `DATABASE_URL`.
- `npm start` runs the server on port 8080.
- Seed a local database with `scripts/seed-db.sh` before running integration tests.
- If Postgres is not running locally, most tests will still pass; only the tests tagged
  `@db` need a live database.

## Commands

- `npm start` — run the server locally.
- `npm test` — run the full test suite. Run it before every push, no exceptions.
- `npm run lint` — check code style. CI runs this too, so save yourself the round trip.
- `npm run typecheck` — we are migrating to TypeScript gradually via JSDoc types; this
  checks them. New code must pass it.
- `npm run migrate` — apply pending database migrations to whatever `DATABASE_URL`
  points at. See the Database section before using this against anything shared.

## Architecture

Request flow: `src/index.js` sets up Express and mounts the routers. Route handlers live
in `src/routes/` — one file per resource. Handlers must stay thin: parse, validate,
call into the domain logic, format the response. Anything longer than ~40 lines in a
handler is a smell.

The versioned partner API lives in `src/api/v1/`. Public checkout traffic and partner
traffic share validation code but have separate routers, because partners get a stricter
contract with frozen field names. When you add a field to an order, add it to the
public router first and only promote it to `src/api/v1/` after it has been stable for a
release.

Shared helpers go in `src/utils/helpers.js`. Date and timezone handling has its own
module, `src/utils/date-helpers.js`, because order cutoff times are timezone-sensitive
and we got this wrong twice before centralizing it. Do not inline date math anywhere
else.

All API route handlers must validate request bodies with the schemas in `src/schemas/`
before touching the database. Return a 400 with the validation error message when
validation fails. Never trust client input, even from internal services.

## Code style

- Use 2-space indentation. Semicolons required. Single quotes for strings.
- CommonJS (`require`/`module.exports`) throughout — do not introduce ESM syntax; the
  deploy image runs the code directly and we have not migrated.
- Always use named exports in shared modules. Never use default exports anywhere in
  this codebase.
- Prefer small pure functions over classes. We have no dependency injection framework
  and do not want one.
- Keep functions under 50 lines. Extract helpers rather than adding nesting.
- No lodash. Modern JavaScript covers everything we used it for.

## API conventions

- Every endpoint returns JSON, even errors. Error shape is `{ error: string }` — a
  human-readable message, no error codes. (Yes, codes would be better; changing this
  breaks partners, so we live with it.)
- Paginate list endpoints with `limit`/`offset` query params, defaulting to 50/0, capped
  at 200. Do not add cursor pagination to old endpoints; partners depend on offsets.
- All timestamps in responses are ISO 8601 UTC with a trailing `Z`. Never return local
  times. If you find an endpoint returning local time, it is a bug — fix it and note it
  in the changelog.
- Idempotency: `POST /orders` accepts an `Idempotency-Key` header. If you touch order
  creation, preserve the idempotency behavior and its tests.

## Testing

- `npm test` runs everything with the built-in Node test runner. Tests live in `test/`,
  mirroring `src/` structure.
- Every bug fix needs a regression test that fails before the fix and passes after. Link
  the test to the incident or issue number in a comment.
- Integration tests that need Postgres are tagged `@db` and run in CI against a
  throwaway container. Locally they are skipped unless `DATABASE_URL` is set.
- Do not mock the validation layer in route tests. Bugs live at the boundary; test the
  boundary.
- Snapshot tests are banned. They rot instantly in this codebase and nobody reads the
  diffs. Assert on the specific fields you care about instead.

## Git workflow

- Branch names: `feat/…`, `fix/…`, `chore/…`. Keep branches short-lived; anything older
  than two weeks probably needs to be restarted rather than rebased.
- Commit messages: imperative mood, under 72 characters for the subject line. Reference
  the ticket in the body, not the subject.
- Before pushing, run `npm test` and make sure every test passes. Open a pull request
  against the `main` branch and request review from at least one backend engineer.
- Squash-merge only. The commit history on `main` should read like a changelog.
- Never force-push a shared branch. If you rewrote history on your own branch, say so
  in the PR so reviewers know to re-review.

## Error handling

- Wrap route handlers with the async error middleware in `src/index.js`; do not add
  bare try/catch blocks that swallow errors.
- Log errors with the request id (`req.id`) so we can correlate across services. Do not
  log request bodies — orders contain customer addresses, which are PII.
- 5xx responses must never include stack traces or internal paths. The error middleware
  handles this; do not bypass it.
- Timeouts talking to Postgres should surface as 503, not 500, so the load balancer
  retries against another instance.

## Performance notes

- The hot path is `POST /orders`. Keep it free of synchronous file IO and unbounded
  loops over line items. Partners send orders with hundreds of line items.
- Pricing rules are cached in memory for 60 seconds. If you change pricing logic, mind
  the cache: stale prices for a minute is accepted, stale prices for an hour is an
  incident (this happened; see INC-2041).
- Do not add per-request database round trips inside line-item loops. Batch the lookups.
  The n+1 in the discount calculator cost us a Black Friday page (INC-1720).

## Deployment

- Merges to `main` deploy to staging automatically. Production deploys are manual,
  through the deploy dashboard, and require a green staging soak of at least 30 minutes.
- Deploys are rolling with a 10% canary. Watch the error-rate panel during the canary
  window; roll back at the first sign of elevated 5xx, do not wait for the pager.
- Feature flags live in the shared flag service. Flags older than 90 days must be
  removed — dead flags have burned us in incident response twice.
- Config is environment variables only. No config files in the image. New variables go
  through `.env.example` with a comment and a default that is safe for local dev.

## Observability

- Metrics go to the shared Prometheus through the `/metrics` endpoint that the platform
  sidecar scrapes. Use the existing histogram helpers; do not invent new metric names
  without checking the naming convention in the platform handbook first.
- Every order mutation emits a structured log line with `order_id`, `partner_id`, and
  the handler name. Dashboards and two alert rules are built on these fields — renaming
  them is a breaking change for the on-call tooling, treat it like an API change.
- Traces are sampled at 1% in production. If you are debugging a specific partner's
  requests, bump sampling for their `partner_id` through the flag service rather than
  raising the global rate; the last global bump doubled our observability bill.
- Alert thresholds live with the alerts, not in this repo. If a change you make is
  expected to shift baseline latency (new validation pass, extra lookup), tell the
  on-call before you deploy so they can pre-adjust instead of getting paged.

## Security

- Partner API keys are verified by the shared auth middleware; never roll your own
  header parsing. Keys are hashed at rest — if you ever see a plaintext key in a log,
  treat it as an incident and rotate it, do not just delete the log line.
- Order payloads are PII (names, addresses, sometimes phone numbers). They must not
  appear in logs, error messages, traces, or test fixtures copied from production.
  Anonymize with the fixtures script before committing anything captured from real
  traffic.
- Dependencies: `npm audit` runs in CI and blocks on high severity. Do not add
  dependencies for things a few lines of code can do — every package here outlives the
  person who added it.
- The service has no admin endpoints on purpose. Operational actions go through the
  deploy dashboard or runbooks, so they are audited. Do not add a "temporary" internal
  endpoint to unblock an operation — that is how the 2020 refund backdoor happened.

## Database

- Postgres 14. Schema changes go through numbered migrations under `scripts/`; never
  edit a migration that has already been merged — write a new one.
- Migrations must be backward compatible one release in each direction, because deploys
  are rolling and two versions run side by side during the canary window.
- Column renames are three steps across three releases: add new column, dual-write and
  backfill, drop old column. There is no safe single-step rename under rolling deploys.
- NEVER run `npm run migrate` against production without taking a database backup
  first and posting in #orders-oncall that a migration is starting. Production
  migrations run through the deploy dashboard's migration step, which enforces the
  backup — running them by hand from a laptop bypasses that safeguard and has caused
  data loss once already (INC-1893).
- Long-running migrations (anything touching the `orders` table) run at 06:00 UTC when
  partner traffic is at its floor. Coordinate with the on-call.

## Troubleshooting

- "Connection terminated unexpectedly" in logs: Postgres failed over. The pool
  reconnects on its own; a burst of these during the nightly maintenance window is
  normal, sustained bursts are not.
- Orders stuck in `pending_pricing`: the pricing cache is likely poisoned. Restart one
  instance and watch whether the stuck orders drain before restarting the rest.
- Partner reports 401s: their API key rotation probably ran early. Check the key
  service audit log before touching our auth code — it has not been the culprit yet.
- Local `npm install` fails on `pg` native build: you are missing libpq headers;
  install them or use Node 18+ where the prebuilt binaries work.

## Historical notes

- The `total` field on orders is in cents and always has been. The one attempt to
  change it to decimal dollars (2021) was reverted within a day. Do not try again.
- We used to have a GraphQL gateway in front of this service. It is gone; if you find
  references to it in comments, delete them as you go.
- The retry queue was moved to the fulfillment service in 2022. `src/queue/` no longer
  exists here — instructions telling you to add retry logic in this repo are outdated.

## Notes for AI assistants

- Prefer minimal diffs. Reviewers here are strict about unrelated changes riding along
  in a PR; if you notice something worth fixing outside the task, mention it in the PR
  description instead of fixing it inline.
- When you are unsure whether behavior is intentional, check the tests first, then the
  Historical notes section above, then ask. Much of what looks accidental is load-bearing.
- Do not regenerate `package-lock.json` unless the task is a dependency change.
- Keep this file up to date: when an instruction here turns out to be wrong or stale,
  fix it in the same PR that revealed the problem.
