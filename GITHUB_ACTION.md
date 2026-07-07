# ctxlint GitHub Action Integration

This document describes the GitHub Action implementation for ctxlint, which allows teams to automatically scan and block pull requests with bloated or conflicting agent context files.

## Overview

The ctxlint GitHub Action (`action.yml`) integrates ctxlint into GitHub's workflow system. When triggered, it:

1. Scans the repository for agent context files (AGENTS.md, CLAUDE.md, .cursor/rules, etc.)
2. Generates a Context Health Score and list of findings
3. Posts results as a PR comment (optional)
4. Fails the check based on configurable thresholds

## Files Added

### 1. `action.yml`

The GitHub Action manifest defining:

- **Inputs**: Configurable parameters like `fail-on-score`, `fail-on-duplication`, etc.
- **Outputs**: Health score, findings count, token count, etc.
- **Runtime**: Node.js 20, using compiled TypeScript in `dist/action-entrypoint.js`

### 2. `src/github-action/entrypoint.ts`

The main entry point executed by GitHub Actions. Responsibilities:

- Parse action inputs from `@actions/core`
- Execute `ctxlint scan` command
- Parse and analyze results
- Set action outputs
- Post PR comments if enabled
- Determine success/failure based on thresholds

**Key Functions:**
- `runAction()`: Main execution flow
- `parseCtxlintOutput()`: Parse JSON or text output from ctxlint
- `buildSummary()`: Format Markdown summary for PR comments
- `postPRComment()`: Create/update GitHub PR comment with results

### 3. `src/github-action/cleanup.ts`

Cleanup handler (post-action), currently a placeholder for future enhancements like:

- Uploading scan reports as artifacts
- Cleaning up temporary files
- Recording metrics to external services

### 4. `src/github-action/helpers.ts`

Utility module for GitHub Action formatting and decision logic:

- `formatMarkdownSummary()`: Convert scan results to Markdown
- `extractOutputs()`: Map scan results to action outputs
- `shouldFail()`: Determine if action should fail based on config

### 5. `dist/action-entrypoint.js` and `dist/action-cleanup.js`

Compiled JavaScript entry points referenced by `action.yml`. These wrap the TypeScript-compiled code with proper ESM imports.

## Usage

### Minimal Example

```yaml
- uses: tqakdev/ctxlint@main
```

### Full Configuration

```yaml
- uses: tqakdev/ctxlint@main
  with:
    path: '.'
    fail-on-score: 70
    fail-on-duplication: true
    fail-on-findings: true
    comment-on-pr: true
    max-token-budget: 100000
```

## Implementation Details

### Input Processing

Inputs are read via `@actions/core.getInput()` and converted to appropriate types:

```typescript
const failOnScore = parseInt(core.getInput('fail-on-score'), 10) || 70;
const commentOnPR = core.getInput('comment-on-pr') === 'true';
```

### Scan Execution

The action attempts to run ctxlint in two ways:

1. Via `npx ctxlint scan --json` (primary)
2. Via direct Node.js module require (fallback)

```typescript
scanOutput = execSync(`npx ctxlint scan ${scanPath} --json`, {
  encoding: 'utf-8',
  cwd: process.cwd(),
});
```

### Output Extraction

Results are set as action outputs for use in subsequent steps:

```typescript
core.setOutput('health-score', String(result.healthScore));
core.setOutput('findings-count', String(result.findings.length));
```

### PR Comments

When enabled and in a PR context, the action:

1. Retrieves existing comments from GitHub API
2. Updates the previous comment if found (idempotent)
3. Creates a new comment if none exists

Comments include:
- Health Score with pass/fail indicator
- Count of findings and critical issues
- Token usage and budget status
- List of top 10 issues with file locations
- Total issue count

### Failure Determination

The action fails if ANY of these conditions are true:

- Health Score < `fail-on-score` threshold
- Duplication found AND `fail-on-duplication` is true
- Critical findings exist AND `fail-on-findings` is true
- Token count exceeds `max-token-budget` (if set)

All conditions are evaluated independently, and reasons are collected in a failure summary.

## Integration with ctxlint Core

The action leverages ctxlint's existing CLI and core modules:

- `ctxlint scan`: Invoked as subprocess to analyze context files
- Output parsing: Handles both JSON and text formats
- Type definitions: Uses `CtxlintScanResult` from core model

This keeps the action thin and focused on GitHub-specific orchestration.

## Testing the Action Locally

You can test the action workflow before pushing:

```bash
# Build the action
npm run build

# Test TypeScript compilation
npm run typecheck

# Verify dist files exist
ls -la dist/action-*.js
```

## Future Enhancements

Potential improvements:

1. **Artifact Upload**: Save full scan reports as workflow artifacts
2. **Metrics Integration**: Send scores to external metrics services
3. **PR Status Checks**: Create GitHub check runs with rich formatting
4. **Configuration File**: Support `.ctxlintrc.json` for action defaults
5. **Monorepo Support**: Scan multiple packages in pnpm/yarn workspaces
6. **Report History**: Track score trends across PRs
7. **Autofixes**: Auto-commit suggestions on permission
8. **Caching**: Cache scan results to speed up CI
