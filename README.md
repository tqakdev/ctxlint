# ctxlint

Linter + profiler + coverage, but for agent context.

`ctxlint` audits, profiles, and scores the context files steering AI coding agents —
`AGENTS.md`, `CLAUDE.md`, `.cursor/rules/*.mdc`, `.github/copilot-instructions.md`, and
skills. It answers: *what does my agent actually load, what does it cost in tokens,
which rules are dead, and do they help?*

```sh
npx ctxlint scan
```

> **Status: under construction.** Built milestone by milestone; the full README with
> quickstart, sample reports, and an honest "what the scores mean" section lands with
> the polish milestone.

## Commands

- `ctxlint scan [path]` — static analysis: findings, Context Health Score, and a
  per-tool table of exactly which files each agent loads and what they cost (tokens are
  ≈ estimated unless `ANTHROPIC_API_KEY` enables exact Anthropic counts).
- `ctxlint fix` — autofix planner; `--write` applies only safe patches.
- `ctxlint compliance` — judge recent commits against your rules (requires
  `ANTHROPIC_API_KEY`); `--calibrate` reports cross-model agreement.
- `ctxlint report` — regenerate the last report from cached results.
