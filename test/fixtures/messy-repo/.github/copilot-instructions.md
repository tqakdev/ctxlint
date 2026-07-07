# Copilot instructions — acme-orders

Order intake service for the Acme storefront. Express + Postgres, CommonJS.

## Workflow

- Before pushing, run `npm test` and make sure every test passes. Open a pull request
  against the `develop` branch and request review from at least one backend engineer.
- Squash-merge only. The commit history should read like a changelog.
- Branch names: `feat/…`, `fix/…`, `chore/…`.

## Components

- Never use named exports for React components. Always use default exports for
  components, so the file name stays the import name.
- Components for the internal dashboard live under `dashboard/components/` and use the
  shared design system; do not hand-roll buttons or form fields.

## Style

- Use 2-space indentation and single quotes.
- Prefer small pure functions over classes.
- Paginate list endpoints with `limit`/`offset` query params, defaulting to 50/0.
