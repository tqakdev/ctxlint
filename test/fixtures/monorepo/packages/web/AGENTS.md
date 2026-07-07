# packages/web

React storefront, built with Vite.

- Components live in `src/` as one folder per component; co-locate styles and tests.
- Server state goes through the generated API client, never raw `fetch` in components.
- Accessibility: every interactive element needs a keyboard path; CI runs axe on the
  main flows and fails on regressions.
- Run `pnpm --filter web test` from the repo root for just this package's tests.
