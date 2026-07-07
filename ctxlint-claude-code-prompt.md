# CLAUDE CODE BUILD PROMPT — paste as the first message in Claude Code, opened in an EMPTY directory

You are a senior TypeScript engineer building **ctxlint** — an open-source CLI that audits, profiles, and scores the context files steering AI coding agents (AGENTS.md, CLAUDE.md, .cursor/rules/*.mdc, .github/copilot-instructions.md, skills). Think of it as **linter + profiler + coverage, but for agent context**.

Work milestone by milestone. At the end of each milestone: run the acceptance checks, show me the demo command output, then STOP and wait for my review before continuing.

---

## 1. Why this exists (design north star)

Teams hand-maintain near-duplicate context files per tool that drift apart, reference files that no longer exist, contradict themselves, silently drop out of long sessions, and cost tokens on every request. Research (ETH Zurich) showed poorly curated context files can make agents *worse* while raising inference cost. Nobody can currently answer: *what does my agent actually load, what does it cost, which rules are dead, and do they help?*

Every design decision optimizes for: **a developer runs one command and immediately learns something true and actionable about their repo.** First-run experience is the product.

## 2. Locked stack (do not substitute without asking)

- **Runtime/lang:** Node ≥ 20, TypeScript strict mode, ESM only.
- **CLI:** `commander`. Colors: `picocolors`. No heavy TUI frameworks.
- **Parsing:** `unified` + `remark-parse` (mdast) for Markdown; `gray-matter` for .mdc frontmatter; `fast-glob` for discovery.
- **Git access:** shell out via `execa` (no libgit2 bindings).
- **Token counting:** `js-tiktoken` with `o200k_base` as the offline **estimate** (label it "≈ estimated tokens" everywhere — tokenizers differ per vendor). If `ANTHROPIC_API_KEY` is set, use `@anthropic-ai/sdk` `messages.countTokens` for exact Anthropic counts and label them exact.
- **LLM calls (compliance module only):** `@anthropic-ai/sdk`, model configurable, default a current Haiku-class model read from config — never hardcode a model string in more than one place (`src/config.ts`).
- **Tests:** `vitest`, fixture-driven. **Lint/format:** `biome`. **Package manager:** `pnpm`.
- **Distribution target:** npm package `ctxlint`, runnable as `npx ctxlint scan`.

Rules: verify every library API against the installed `node_modules` typings before using it — do not code from memory of an API. If a dependency's actual API differs from what you expected, adapt to reality and note it. Zero `any` in `src/` except at validated I/O boundaries.

## 3. Domain model (define first, in `src/core/model.ts`)

```ts
type ToolId = "claude-code" | "cursor" | "copilot" | "codex" | "generic-agents-md";

interface Surface {            // one physical context file
  id: string;                  // stable hash of path
  path: string;                // repo-relative
  kind: "agents-md" | "claude-md" | "cursor-rule" | "copilot-instructions" | "skill" | "other";
  scope: "repo-root" | "subtree" | "user-global";
  tools: ToolId[];             // which tools load this surface
  raw: string;
  tokensEstimated: number;
  tokensExact?: number;
  meta?: Record<string, unknown>;   // e.g. .mdc frontmatter: globs, alwaysApply
}

interface Rule {               // one atomic instruction extracted from a surface
  id: string;                  // surfaceId + ordinal
  surfaceId: string;
  text: string;                // normalized single instruction
  section: string[];           // heading path
  span: { startLine: number; endLine: number };
  kind: "imperative" | "context" | "structure-claim" | "command" | "unknown";
  referencedPaths: string[];   // path-like tokens found in the text
}

interface EffectiveContext {   // what ONE tool actually loads for ONE directory
  tool: ToolId;
  directory: string;
  surfaces: { surface: Surface; reason: string; order: number }[];
  totalTokensEstimated: number;
}

interface Finding {
  ruleIds: string[];
  surfaceIds: string[];
  severity: "error" | "warn" | "info";
  category: "duplication" | "drift" | "contradiction" | "stale-reference"
          | "budget" | "structure" | "dead-rule" | "load-semantics";
  message: string;             // human sentence, specific, actionable
  evidence: string;            // quoted snippets / diff / numbers
  fix?: FixSuggestion;
}

interface FixSuggestion {
  kind: "delete-rule" | "merge-rules" | "move-to-front" | "update-path" | "split-file" | "rewrite";
  description: string;
  patch?: string;              // unified diff when safely automatable
}
```

Every analyzer consumes `Surface[]`/`Rule[]` and emits `Finding[]`. Analyzers must be pure functions — no I/O — so they are trivially testable.

## 4. Load-semantics resolvers (`src/core/resolvers/`)

Encode, per tool, which files it reads and in what precedence. Implement from the tools' documented behavior; where behavior is undocumented or ambiguous, mark the resolver rule with `confidence: "assumed"` and surface that in output rather than presenting guesses as fact. Minimum v1 semantics:

- **claude-code:** `CLAUDE.md` at repo root; `CLAUDE.md` in subdirectories apply to work in that subtree; user-global `~/.claude/CLAUDE.md` (flag as "not visible to teammates" if referenced); also reads `AGENTS.md`.
- **cursor:** `.cursor/rules/*.mdc` with frontmatter `globs`/`alwaysApply` controlling activation scope; treats `AGENTS.md` as rules-equivalent.
- **copilot:** `.github/copilot-instructions.md`; reads `AGENTS.md`.
- **codex / generic:** `AGENTS.md` hierarchy (root + nested).

`ctxlint scan` must be able to answer: *"for tool T working in directory D, these N files totaling ~K tokens are injected, in this order."* That table is the profiler's core output.

## 5. Commands & features

### `ctxlint scan [path]` (default command) — static analysis
1. **Discovery:** find all surfaces (respect `.gitignore`; follow no symlinks; skip files > 1 MB with a warn finding).
2. **Parse → Rules:** split markdown into atomic rules (list items and imperative sentences under headings). Classify `kind` heuristically (imperative verbs; path-like tokens ⇒ structure-claim; fenced `bash` ⇒ command).
3. **Analyzers (each its own file in `src/core/analyzers/`):**
   - **duplication/drift:** normalized 5-gram shingles + Jaccard across rules in *different* surfaces. ≥ 0.9 ⇒ duplication (error if surfaces feed different tools: "same rule maintained twice"); 0.6–0.9 ⇒ drift (warn: "these started identical and diverged — show diff"). Pairwise comparison is O(n²) on rule count with set-intersection cost per pair; fine for n ≤ ~5k rules — assert and bail gracefully above that.
   - **contradiction (heuristic tier):** for rule pairs with similarity 0.5–0.9, detect polarity flips (always/never, do/don't, prefer X/prefer Y on matching object shingles). Emit as `warn` with both quotes. (LLM-tier contradiction detection belongs to the compliance module, not here.)
   - **stale-reference:** for every `referencedPaths` entry (path-like tokens, globs, `package.json` script names, dependency names) verify existence in the repo. Missing ⇒ error: "rule references `src/api/v1/` which does not exist — actively misleading the agent."
   - **budget:** per-surface and per-EffectiveContext token totals; warn thresholds (default: surface > 1,500 est. tokens, effective context > 4,000) configurable via `ctxlint.config.json`. Flag rules buried > 70% deep in oversized files as "likely lost in long sessions — move critical rules to the front."
   - **structure:** repos with 3+ parallel tool files whose content overlaps < 50% ⇒ suggest consolidating on AGENTS.md + thin per-tool pointers; empty/boilerplate surfaces; surfaces no known tool loads (`load-semantics` info: "this file is read by nothing you use").
4. **Scoring:** Context Health Score 0–100 = weighted subscores (freshness, uniqueness, consistency, budget, structure). Deterministic, documented formula in `src/core/scoring.ts` — same input, same score.
5. **Output:** terminal summary (score, top findings, effective-context table per tool), plus `--format json|md`, `--output <file>`. Exit code 1 when errors exist and `--ci` is set.

### `ctxlint fix` — autofix planner
Reads scan findings, produces `ctxlint-fixes.md` (grouped, human-readable) and applies **only safe** patches with `--write`: delete exact duplicates (keep canonical copy in AGENTS.md), update stale paths when a unique rename target exists in git history (`git log --follow --diff-filter=R`), reorder critical rules to front. Anything judgment-requiring stays a suggestion. `--write` must refuse to run on a dirty git tree.

### `ctxlint compliance` — the dynamic layer (requires `ANTHROPIC_API_KEY`)
1. **Sampler:** last N merged changes (`git log --merges` fallback plain commits; `--commits N`, default 30). Extract diffs, chunk to ≤ ~4k tokens per judged unit, skip lockfiles/generated/vendored paths.
2. **Judge:** for each (rule, diff-chunk) pair where the rule plausibly applies (cheap prefilter: shared file-glob/keyword overlap — do NOT send every pair), ask the model for a strict JSON verdict: `followed | violated | not-applicable` + one-line quote of evidence. Batch requests; concurrency limit 4; exponential backoff; cache verdicts on disk keyed by (ruleHash, chunkHash, model) so reruns are incremental and cheap.
3. **Report per rule:** applicability count, followed %, violated % with evidence quotes. Rules with 0 applicable samples across N commits ⇒ **dead-rule candidates**. Print total API cost estimate up front and require `--yes` above a configurable spend cap (default $1).
4. **`ctxlint compliance --calibrate`:** re-judge a 10% sample with a second model (configurable) and report agreement %. Print prominently: below 80% agreement, per-rule scores should be treated as directional only. This honesty feature is non-negotiable — it is the product's credibility.

### `ctxlint report` — regenerate last report from cached results without re-scanning.

## 6. Repository layout

```
ctxlint/
├── src/
│   ├── cli.ts                 # commander wiring only — no logic
│   ├── config.ts              # config file + defaults + model names (single source)
│   ├── core/
│   │   ├── model.ts
│   │   ├── discovery.ts
│   │   ├── parsers/           # agentsMd.ts, cursorRule.ts, copilot.ts, skill.ts
│   │   ├── resolvers/         # claudeCode.ts, cursor.ts, copilot.ts, codex.ts, index.ts
│   │   ├── analyzers/         # duplication.ts, contradiction.ts, staleness.ts, budget.ts, structure.ts
│   │   ├── tokens.ts          # estimate + exact counting behind one interface
│   │   └── scoring.ts
│   ├── compliance/            # sampler.ts, prefilter.ts, judge.ts, cache.ts, calibrate.ts
│   ├── fix/                   # planner.ts, writer.ts
│   └── report/                # terminal.ts, markdown.ts, json.ts
├── action/                    # composite GitHub Action: runs scan --ci, posts PR comment
├── test/
│   ├── fixtures/
│   │   ├── clean-repo/        # healthy setup → score > 85, no errors
│   │   ├── messy-repo/        # duplicated CLAUDE.md/.cursorrules drift, stale paths, 3k-token file, contradiction
│   │   └── monorepo/          # nested AGENTS.md, .mdc globs, subtree resolution
│   └── *.test.ts
├── README.md
├── package.json               # bin: { "ctxlint": "dist/cli.js" }
└── ctxlint.config.schema.json
```

## 7. Milestones (stop after each)

- **M0 — Scaffold.** pnpm + TS strict + biome + vitest + commander skeleton with `--help`. All three fixture repos created with realistic content (write them thoughtfully — they are the test bed and the demo). ✅ `pnpm test` green, `pnpm build` emits runnable CLI.
- **M1 — Discovery + parsing + resolvers.** `ctxlint scan` prints the surface inventory and per-tool effective-context table with token estimates for all fixtures. ✅ Snapshot tests per fixture; monorepo subtree resolution correct.
- **M2 — Analyzers + scoring + reports.** Full static findings, health score, `--format json|md`, `--ci` exit codes. ✅ messy-repo triggers every finding category with correct evidence; clean-repo scores > 85; scoring is deterministic.
- **M3 — Fix planner.** `ctxlint fix` suggestions + `--write` safe patches on messy-repo fixture (verified by re-running scan: score improves, no content lost beyond exact dupes). ✅ dirty-tree refusal tested.
- **M4 — Compliance + calibrate.** Judge pipeline with prefilter, disk cache, spend cap, calibration report. Mock the Anthropic client in tests (inject the client — never call the network in tests). ✅ verdict parsing rejects malformed JSON safely; cache hit path tested; cost estimator tested.
- **M5 — Polish + Action + README.** GitHub Action posting a PR comment; README with a 30-second quickstart, sample report screenshot (text block is fine), honest "what the scores mean / limits" section including that token counts are estimates and compliance is judge-based. ✅ `npx` flow works from a packed tarball (`pnpm pack` + install in temp dir).

## 8. Quality bar & edge cases (handle explicitly)

Windows paths; repos with no git history (compliance degrades gracefully with a clear message); zero context files found (friendly onboarding message suggesting `AGENTS.md`, exit 0); non-UTF-8 files (skip + info finding); rules written in non-English (all analyzers must be language-agnostic where heuristic — shingles work on any script; polarity heuristics are English-only, say so in output); `.mdc` with broken frontmatter (finding, not crash); huge monorepos (stream, don't slurp; hard cap with `--max-files`). Every finding message must name the file, line span, and the concrete action — a finding a developer can't act on in 60 seconds is a bug.

## 9. What NOT to do

No SaaS/dashboard/telemetry in v1. No config sprawl — every option needs a default that's right for 90% of repos. No LLM calls anywhere except the `compliance` module. No invented tool load-semantics presented as fact — mark assumptions. No placeholder implementations left behind: if a milestone ships it, it works and is tested.

Begin with M0. Before writing code, restate your plan for M0 in 5 lines and list any assumptions you're making.
