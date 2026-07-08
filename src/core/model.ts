/**
 * Domain model for ctxlint. Every analyzer consumes Surface[]/Rule[] and emits
 * Finding[]; analyzers are pure functions (no I/O) so they are trivially testable.
 */

export type ToolId =
  | "claude-code"
  | "cursor"
  | "copilot"
  | "codex"
  | "windsurf"
  | "generic-agents-md";

export const TOOL_IDS: readonly ToolId[] = [
  "claude-code",
  "cursor",
  "copilot",
  "codex",
  "windsurf",
  "generic-agents-md",
];

export type SurfaceKind =
  | "agents-md"
  | "claude-md"
  | "cursor-rule"
  | "copilot-instructions"
  | "windsurf-rule"
  | "skill"
  | "other";

export type SurfaceScope = "repo-root" | "subtree" | "user-global";

/** One physical context file. */
export interface Surface {
  /** Stable hash of path. */
  id: string;
  /** Repo-relative, posix separators. User-global files use a `~/` prefix. */
  path: string;
  kind: SurfaceKind;
  scope: SurfaceScope;
  /** Which tools load this surface (empty = read by nothing known). */
  tools: ToolId[];
  raw: string;
  tokensEstimated: number;
  tokensExact?: number;
  /** e.g. .mdc frontmatter: globs, alwaysApply; or frontmatterError. */
  meta?: Record<string, unknown>;
}

export type RuleKind = "imperative" | "context" | "structure-claim" | "command" | "unknown";

/** One atomic instruction extracted from a surface. */
export interface Rule {
  /**
   * surfaceId + content hash of the normalized rule text, so identity survives
   * reformatting and reordering. Duplicate text in one surface appends an
   * occurrence suffix (`.2`, `.3`, …).
   */
  id: string;
  surfaceId: string;
  /** Normalized single instruction. */
  text: string;
  /** Heading path. */
  section: string[];
  span: { startLine: number; endLine: number };
  kind: RuleKind;
  /**
   * Path-like tokens found in the text. Globs contain `*`; npm script
   * references are stored as "npm run <name>".
   */
  referencedPaths: string[];
}

export interface EffectiveContextEntry {
  surface: Surface;
  reason: string;
  order: number;
  /** True when activation depends on which file is being edited (e.g. .mdc globs). */
  conditional?: boolean;
}

/** What ONE tool actually loads for ONE directory. */
export interface EffectiveContext {
  tool: ToolId;
  directory: string;
  surfaces: EffectiveContextEntry[];
  /** Sum over always-on entries only. */
  totalTokensEstimated: number;
  /** Sum over conditional entries (glob-activated etc.). */
  conditionalTokensEstimated: number;
}

export type Severity = "error" | "warn" | "info";

export type FindingCategory =
  | "duplication"
  | "drift"
  | "contradiction"
  | "stale-reference"
  | "budget"
  | "structure"
  | "dead-rule"
  | "load-semantics";

export interface Finding {
  ruleIds: string[];
  surfaceIds: string[];
  severity: Severity;
  category: FindingCategory;
  /** Human sentence, specific, actionable; names file and line span. */
  message: string;
  /** Quoted snippets / diff / numbers. */
  evidence: string;
  fix?: FixSuggestion;
}

export type FixKind =
  | "delete-rule"
  | "merge-rules"
  | "move-to-front"
  | "update-path"
  | "split-file"
  | "rewrite";

export interface FixSuggestion {
  kind: FixKind;
  description: string;
  /**
   * For update-path: the exact referenced path/script this finding is about,
   * so the planner never rewrites the rule's OTHER references.
   */
  ref?: string;
  /** Unified diff when safely automatable. */
  patch?: string;
}

export const SEVERITY_RANK: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

/** Deterministic ordering: severity, then category, then message. */
export function compareFindings(a: Finding, b: Finding): number {
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (bySeverity !== 0) return bySeverity;
  const byCategory = a.category.localeCompare(b.category);
  if (byCategory !== 0) return byCategory;
  return a.message.localeCompare(b.message);
}
