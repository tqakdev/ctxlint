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

## GitHub Action: Block PRs with Bloated Context Files

Use ctxlint as a GitHub Action to automatically scan and block PRs that contain bloated or conflicting agent context files.

### Quick Start

Add this workflow to `.github/workflows/ctxlint.yml`:

```yaml
name: ctxlint Scan

on:
  pull_request:
    paths:
      - 'AGENTS.md'
      - 'CLAUDE.md'
      - '.cursorrules'
      - '.cursor/rules/**'
      - '.github/copilot-instructions.md'

jobs:
  ctxlint:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      checks: write
      contents: read
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Run ctxlint
        uses: tqakdev/ctxlint@main
        with:
          path: '.'
          fail-on-score: '70'
          fail-on-duplication: 'true'
          fail-on-findings: 'true'
          comment-on-pr: 'true'
```

### Action Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `path` | `.` | Path to scan (repository root or subdirectory) |
| `fail-on-score` | `70` | Fail if Context Health Score is below this threshold (0-100) |
| `fail-on-duplication` | `true` | Fail if duplicate or conflicting rules are detected |
| `fail-on-findings` | `true` | Fail if critical findings are present |
| `comment-on-pr` | `true` | Post scan results as a PR comment |
| `max-token-budget` | `0` | Maximum allowed total tokens (0 = no limit) |

### Action Outputs

| Output | Description |
|--------|-------------|
| `health-score` | Context Health Score (0-100) |
| `findings-count` | Total number of findings detected |
| `critical-count` | Number of critical findings |
| `duplication-count` | Number of duplication/conflict issues |
| `total-tokens` | Total tokens in context files |

### Example Workflows

#### Strict Mode: Fail on Any Issues

```yaml
- name: Run ctxlint - Strict
  uses: tqakdev/ctxlint@main
  with:
    fail-on-score: '85'
    fail-on-duplication: 'true'
    fail-on-findings: 'true'
    max-token-budget: '50000'
```

#### Token Budget Enforcement

```yaml
- name: Run ctxlint - Token Budget
  uses: tqakdev/ctxlint@main
  with:
    max-token-budget: '100000'
    comment-on-pr: 'true'
```

#### Warning Only (No Fail)

```yaml
- name: Run ctxlint - Report Only
  uses: tqakdev/ctxlint@main
  with:
    fail-on-score: '0'
    fail-on-duplication: 'false'
    fail-on-findings: 'false'
    comment-on-pr: 'true'
```

### What the Action Checks

The ctxlint GitHub Action performs the following checks on your agent context files:

1. **Context Health Score** — measures overall quality and organization of context files (0-100)
2. **Duplicate Rules** — detects identical or conflicting rules across files
3. **Token Budget** — ensures context files don't exceed specified token limits
4. **Critical Findings** — reports structural issues, staleness, or problematic patterns
5. **File Coverage** — tracks which files each agent tool loads

### Understanding Health Score

The Context Health Score (0-100) is calculated by:

- **Rule Organization** (25 points) — well-organized, clearly documented rules
- **Token Efficiency** (25 points) — minimal redundancy, focused content
- **Conflict Resolution** (25 points) — no contradictions or duplicate instructions
- **Freshness** (25 points) — rules are current and actively maintained

A score of 70+ indicates healthy context files; below 50 suggests significant cleanup needed.

### Blocking PRs

By default, the action fails the check (blocks PR merge) when:

- Health Score drops below 70
- Duplicate or conflicting rules are found
- Critical findings are detected

All settings are configurable. Set `fail-on-*` inputs to `false` to post results without blocking.

### PR Comments

When enabled, the action posts a detailed comment on each PR showing:

- Current Health Score
- Total findings and critical issues
- Token count and budget status
- List of top issues found
- Recommendations for remediation
