# ctxlint

**Linter + profiler + coverage, but for agent context.**

`ctxlint` audits, profiles, and scores the context files steering AI coding agents —
`AGENTS.md`, `CLAUDE.md`, `.cursor/rules/*.mdc`, `.github/copilot-instructions.md`,
`.windsurf/rules/*.md`, and skills. It answers the questions nobody can currently
answer about their repo:

- **What does my agent actually load?** Per tool, per directory, in what order, and why.
- **What does it cost?** Token totals for the context injected on every request.
- **Which rules are broken?** Duplicated across tools, drifted apart, contradictory,
  pointing at files that no longer exist, or buried so deep they get lost.
- **Do they help?** Judge recent commits against your rules to find violations and
  dead rules that never apply to anything.

## Install

The npm package is **`@tqakdev/ctxlint`**; the command it installs is **`ctxlint`**.

```sh
npx @tqakdev/ctxlint scan          # one-off, no install
npm i -g @tqakdev/ctxlint          # then run `ctxlint` anywhere
```

## Quickstart (30 seconds)

```sh
npx @tqakdev/ctxlint scan
```

That's it — no config needed. You get a Context Health Score (0–100), a per-tool table
of exactly which files each agent loads and what they cost, and a list of findings you
can act on in under a minute each.

## Sample report

Running `ctxlint scan` on a repo with hand-maintained, drifted context files:

```text
ctxlint — 5 context file(s), 95 rules

Context Health Score: 46/100
  freshness 0  uniqueness 8  consistency 76  budget 82  structure 84

Context files
  file                             kind                  tools        tokens≈  rules
  .cursor/rules/broken.mdc         cursor-rule           cursor       ≈37      2
  .cursor/rules/style.mdc          cursor-rule           cursor       ≈184     7
  .cursorrules                     other                 —            ≈56      5
  .github/copilot-instructions.md  copilot-instructions  copilot      ≈210     9
  CLAUDE.md                        claude-md             claude-code  ≈2812    72

claude-code @ . — ≈2812 tokens always-on
  #  file       tokens≈  why
  1  CLAUDE.md  ≈2812    CLAUDE.md at repo root

cursor @ . — ≈184 tokens always-on (+ ≈37 conditional)
  #  file                      tokens≈  why
  1  .cursor/rules/broken.mdc  ≈37      frontmatter unparseable — activation unknown, assumed not auto-attached
  2  .cursor/rules/style.mdc   ≈184     alwaysApply: true

Findings: 15 error(s), 6 warning(s), 2 info
  ✖ [duplication] Same rule maintained twice for different tools: .cursor/rules/style.mdc:10-11
    and CLAUDE.md:65-66 are 100% identical. Keep one canonical copy (prefer AGENTS.md) and
    delete the other.
  ✖ [stale-reference] CLAUDE.md:45-49 references `src/api/v1/` which does not exist —
    actively misleading the agent. Update the reference or delete the rule.
  ▲ [drift] These rules started identical and diverged (66% similar):
    .github/copilot-instructions.md:7-8 vs CLAUDE.md:104-105.
      diff: … against the [-main-] {+develop+} branch and …
  ▲ [contradiction] Contradictory instructions about the same thing (polarity heuristic
    is English-only):
      A: "Always use named exports in shared modules."
      B: "Never use named exports for React components."
  ▲ [budget] 9 critical rule(s) buried past 70% depth of an oversized file (CLAUDE.md,
    deepest at line 217 = 99%) — likely lost in long sessions. Move critical rules to the front.
  ℹ [load-semantics] .cursorrules is read by no tool ctxlint knows (legacy format) —
    migrate its rules into .cursor/rules/*.mdc or AGENTS.md, then delete this file.
```

## Commands

### `ctxlint scan [path]` — static analysis (default command)

Discovers every context surface (respecting `.gitignore` and `discovery.exclude`,
skipping symlinks and files over 1 MB), splits them into atomic rules, resolves
per-tool load semantics, runs five analyzers, and prints the report.

Load-order semantics are modeled from each tool's official docs; the report carries
the doc link, a last-verified date, and every assumption the model makes (the
"Load-order model provenance" table in `--format md`/`json`), so when a tool changes
behavior the stale assumption is visible instead of silently wrong.

| flag | what it does |
|---|---|
| `--format text\|json\|md\|sarif` | output format (default `text`); `sarif` plugs into GitHub code scanning |
| `--output <file>` | write the report to a file |
| `--ci` | exit 1 when error-severity findings exist |
| `--max-files <n>` | cap the discovery walk on huge monorepos |

### `ctxlint fix [path]` — autofix planner

Writes `ctxlint-fixes.md` with every fix grouped into **safe** (auto-applicable) and
**suggestions** (need your judgment). `--write` applies only the safe set:

1. delete exact duplicates, keeping the canonical copy (AGENTS.md ranks highest);
2. update stale paths when git history shows a unique rename target;
3. move buried critical rules to the front — only ones the author CAPITALIZED
   (NEVER/MUST/ALWAYS); lowercase judgment calls stay suggestions.

`--write` refuses to run on a dirty git tree, so every change is reviewable and
revertable.

### `ctxlint compliance [path]` — do the rules actually help? (requires `ANTHROPIC_API_KEY`)

Samples your last N merged changes (default 30; falls back to plain commits), skips
lockfiles/vendored/generated code, prefilters (rule, diff-chunk) pairs by file and
keyword overlap, then asks a model for a strict-JSON verdict per pair:
`followed | violated | not-applicable` with a one-line evidence quote.

- **Spend cap**: total cost is estimated up front; anything above $1 (configurable)
  requires `--yes`.
- **Disk cache**: verdicts are keyed by (rule, chunk, model) so reruns are incremental
  and nearly free.
- **Dead rules**: rules that apply to nothing across the sample are called out — they
  cost tokens on every request and never change behavior.
- **`--calibrate`**: re-judges a 10% sample with a second model and prints the
  agreement rate. Below 80%, the report tells you — prominently — to treat per-rule
  scores as directional only.

### `ctxlint report` — re-render the last scan

Regenerates the report from `.ctxlint-cache/last-scan.json` without re-scanning
(`--format`, `--output` as above).

## GitHub Action

Add a Context Health check that comments on every PR:

```yaml
# .github/workflows/ctxlint.yml
name: context-health
on: [pull_request]
permissions:
  contents: read
  pull-requests: write
jobs:
  ctxlint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: tqakdev/ctxlint/action@main
        with:
          fail-on-error: "true"   # gate the job on error-severity findings
          fail-on-score: "0"      # optionally require a minimum Context Health Score (0 disables)
          comment: "true"         # post/update the report as a PR comment
```

The action also writes the report to the job summary and exposes `score` and `errors`
as outputs.

### GitHub code scanning (SARIF)

Findings can land in the repo's Security tab — with file/line annotations on PRs —
via the standard SARIF upload:

```yaml
      - run: npx @tqakdev/ctxlint scan --format sarif --output ctxlint.sarif
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: ctxlint.sarif
```

## Pre-commit hook

Catch broken context files before they land. Plain git hook — no extra dependency:

```bash
# .git/hooks/pre-commit  (chmod +x)
#!/bin/sh
# Only run when a context file is in the commit.
if git diff --cached --name-only | grep -qE \
  '(^|/)(AGENTS|CLAUDE|SKILL)\.md$|\.cursor(rules)?(/|$)|\.mdc$|\.windsurf(rules)?(/|$)|copilot-instructions\.md$'; then
  npx @tqakdev/ctxlint scan --ci || {
    echo "ctxlint: error-severity findings — fix them or commit with --no-verify" >&2
    exit 1
  }
fi
```

With [husky](https://typicode.github.io/husky/):

```bash
echo "npx @tqakdev/ctxlint scan --ci" > .husky/pre-commit
```

`--ci` exits 1 only on error-severity findings (stale references, cross-tool
duplicates); warnings and infos never block a commit.

## Configuration

Everything has a default aimed at typical repos; create `ctxlint.config.json` only to
change something (schema in [`ctxlint.config.schema.json`](./ctxlint.config.schema.json)):

```json
{
  "budgets": { "surfaceWarnTokens": 1500, "effectiveContextWarnTokens": 4000 },
  "compliance": { "model": "claude-haiku-4-5", "commits": 30, "spendCapUsd": 1 }
}
```

| section | option | default | meaning |
|---|---|---:|---|
| budgets | `surfaceWarnTokens` | 1500 | warn when one file exceeds this many estimated tokens |
| budgets | `effectiveContextWarnTokens` | 4000 | warn when one tool's always-on context exceeds this |
| budgets | `buriedRuleDepthRatio` | 0.7 | flag critical rules deeper than this fraction of an oversized file |
| discovery | `maxFiles` | 20000 | hard cap on the repo walk (`--max-files` overrides) |
| discovery | `exclude` | `[]` | globs for context files that are not live surfaces (test fixtures, examples) — skipped by analysis but kept in the repo index, so references to them stay valid |
| analysis | `maxRules` | 5000 | pairwise analyzers bail gracefully above this |
| compliance | `model` / `calibrationModel` | haiku / sonnet | judge and second-opinion models |
| compliance | `spendCapUsd` | 1 | require `--yes` above this estimated spend |

## What the scores mean — and what they don't

Honesty section. Read this before trusting a number.

- **Token counts are estimates.** Offline counting uses js-tiktoken (`o200k_base`) and
  is labeled `≈` everywhere; vendor tokenizers differ, so treat counts as ±10–20%,
  more for CJK-heavy content. With `ANTHROPIC_API_KEY` set, `scan` fetches exact
  Anthropic counts and labels them exact.
- **The Context Health Score is deterministic, not divine.** Same input, same score —
  the formula is documented in `src/core/scoring.ts` (five weighted subscores; per-finding
  penalties of 25/10/4 for error/warn/info, each repeat within a subscore counting 0.8×
  the previous so one bad file can't flatline the whole subscore, though ~8 errors still
  drive it to 0). It's a trend instrument: watch it move in CI, don't worship
  the absolute number.
- **Compliance verdicts are judge-based.** An LLM reads a rule and a diff and gives an
  opinion. Run `--calibrate` to measure cross-model agreement; below 80% the report
  itself tells you the scores are directional. Dead-rule detection depends on your
  sample size — a rule that applied to nothing in 30 commits might apply next week.
- **Load semantics are best-effort.** Tool behavior is encoded from documented
  behavior; where it's undocumented, the table says "(assumed)" instead of presenting
  a guess as fact. Legacy `.cursorrules` is treated as loaded by nothing (assumed);
  legacy `.windsurfrules` is treated as still read by Windsurf (deprecated format).
- **Some heuristics are English-only.** Duplication/drift shingles work on any
  language; polarity-based contradiction detection only understands English
  always/never phrasing, and says so in each finding.
- **Pairwise analysis is O(n²).** Above 5000 rules (configurable), duplication/drift
  analysis bails gracefully with a note rather than hanging your CI.

## Benchmark: measured precision on real repos

Every finding ctxlint produces on seven pinned open-source repos (openai/codex,
sst/opencode, All-Hands-AI/OpenHands, cline/cline, block/goose, vercel/ai,
browser-use/browser-use — `bench/corpus.json`) is hand-labeled true/false
positive against the actual checkout (`bench/labels.json`, 120 findings):

| category | precision | tp / fp | notes |
|---|---:|---|---|
| budget | 98% | 57 / 1 | token math is token math |
| stale-reference | 91% | 52 / 5 | the flagship analyzer |
| duplication | 100% | 2 / 0 | small sample |
| contradiction | 33% | 1 / 2 | small sample — being reworked |
| structure | — | 0 / 0 | all earlier fps fixed |
| **overall** | **93%** | **112 / 8** | |

The first labeling pass measured 67% overall (stale-reference 52%). Instead of
publishing that and moving on, the labeled false positives became the fix list:
resolve references against ancestor directories and `cd` contexts, complete
import-specifier extensions (`./native-request` → `native-request.ts`), treat
bare filenames that exist anywhere as findable, understand creation/removal/
conditional sentences ("do not create X", "when `.pr/` exists"), and drop
never-path tokens (`text/*`, `Schema.Json`, `kebab-case.ts`, ellipsis paths).
Two resolution bugs were found the same way. The surviving true positives are
the real thing: cline's entire `copilot-instructions.md` describes a repo
layout that no longer exists, and OpenHands' AGENTS.md still points at its
pre-refactor tree.

Reproduce with `pnpm bench` (clones the pinned SHAs, ~200 MB); `pnpm bench
--check` fails if analyzer output drifts from the committed snapshots. Labels
are re-audited whenever a snapshot changes — precision claims stay tied to
the exact code that earns them.

## Development

```sh
pnpm install
pnpm test        # vitest, fixture-driven — no network calls anywhere in tests
pnpm typecheck   # TS strict
pnpm lint        # biome
pnpm build       # emits dist/, runnable as node dist/cli.js
```

The three fixture repos under `test/fixtures/` are the test bed: `clean-repo` scores
100, `messy-repo` triggers every finding category, `monorepo` exercises subtree and
glob-scoped resolution.

## License

MIT
