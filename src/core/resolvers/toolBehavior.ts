import type { ToolId } from "../model.js";

/**
 * Versioned record of what ctxlint believes about each tool's context-loading
 * behavior. Resolvers encode these beliefs as code; this file is the contract
 * that makes them checkable: when a tool changes, update the resolver, the
 * assumptions here, and bump lastVerified in the same commit.
 */
export interface ToolBehavior {
  /** Official documentation the load model was derived from. */
  docsUrl: string;
  /** Date a human last checked docsUrl against the resolver (YYYY-MM-DD). */
  lastVerified: string;
  /** Behavior the docs do not confirm — mirrored as "(assumed)" in reasons. */
  assumptions: string[];
}

export const TOOL_BEHAVIOR: Record<ToolId, ToolBehavior> = {
  "claude-code": {
    docsUrl: "https://code.claude.com/docs/en/memory",
    lastVerified: "2026-07-08",
    assumptions: ["relative injection order of AGENTS.md vs CLAUDE.md at the same level"],
  },
  cursor: {
    docsUrl: "https://docs.cursor.com/context/rules",
    lastVerified: "2026-07-08",
    assumptions: [
      ".mdc rules with neither alwaysApply nor globs are agent-requested only",
      "legacy .cursorrules is deprecated and no longer loaded",
    ],
  },
  copilot: {
    docsUrl:
      "https://docs.github.com/en/copilot/customizing-copilot/adding-repository-custom-instructions-for-github-copilot",
    lastVerified: "2026-07-08",
    assumptions: ["nested AGENTS.md files apply to their subtree"],
  },
  codex: {
    docsUrl: "https://developers.openai.com/codex",
    lastVerified: "2026-07-08",
    assumptions: ["AGENTS.md files merge root-down along the directory chain"],
  },
  windsurf: {
    docsUrl: "https://docs.windsurf.com/windsurf/cascade/memories",
    lastVerified: "2026-07-08",
    assumptions: [
      "trigger frontmatter semantics (manual/model/glob/always) for .windsurf/rules/*.md",
      "rules without an always trigger load on demand only",
    ],
  },
  "generic-agents-md": {
    docsUrl: "https://agents.md",
    lastVerified: "2026-07-08",
    assumptions: ["nearest AGENTS.md wins; ancestors still apply for the subtree"],
  },
};
