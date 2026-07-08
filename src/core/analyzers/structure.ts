import type { Finding, Rule, Surface } from "../model.js";
import { jaccard, normalizeWords, shingles } from "./shingles.js";

const PER_TOOL_KINDS = new Set([
  "claude-md",
  "cursor-rule",
  "copilot-instructions",
  "windsurf-rule",
  "other",
]);

/**
 * Repo-shape findings: per-tool file sprawl, empty/boilerplate surfaces,
 * surfaces no known tool loads, and user-global references.
 */
export function analyzeStructure(surfaces: Surface[], rules: Rule[]): Finding[] {
  const findings: Finding[] = [];
  const repoSurfaces = surfaces.filter((s) => s.scope !== "user-global");

  // 1. Sprawl: 3+ parallel per-tool files AT THE REPO ROOT that mostly don't
  //    overlap — each is hand-maintained separately and they will keep
  //    drifting apart. Subtree files are scoping, not sprawl.
  const perTool = repoSurfaces.filter((s) => PER_TOOL_KINDS.has(s.kind) && s.scope === "repo-root");
  if (perTool.length >= 3) {
    const sets = perTool.map((s) => shingles(normalizeWords(s.raw)));
    let pairs = 0;
    let totalSimilarity = 0;
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        totalSimilarity += jaccard(sets[i] as Set<string>, sets[j] as Set<string>);
        pairs += 1;
      }
    }
    const mean = pairs === 0 ? 0 : totalSimilarity / pairs;
    if (mean < 0.5) {
      findings.push({
        ruleIds: [],
        surfaceIds: perTool.map((s) => s.id),
        severity: "info",
        category: "structure",
        message: `${perTool.length} per-tool context files (${perTool.map((s) => s.path).join(", ")}) overlap by only ${Math.round(mean * 100)}% — they are separate documents that will keep drifting. Consolidate shared rules into AGENTS.md (every tool here reads it) and keep only tool-specific notes per file.`,
        evidence: `mean pairwise content overlap ${Math.round(mean * 100)}%`,
        fix: {
          kind: "rewrite",
          description:
            "Move shared rules to AGENTS.md; reduce per-tool files to genuinely tool-specific instructions.",
        },
      });
    }
  }

  for (const surface of repoSurfaces) {
    // 2. Empty / boilerplate surfaces. A CLAUDE.md consisting of @imports
    //    ("@AGENTS.md") is a deliberate redirect — Claude Code inlines the
    //    target file — not boilerplate. A short file carrying a real command
    //    (`bun dev:stats`) tells the agent something, however terse.
    const hasClaudeImports = surface.kind === "claude-md" && /^@\S+\s*$/m.test(surface.raw);
    const hasCommand = /`[^`\n]{2,}`/.test(surface.raw);
    const bodyChars = surface.raw.replace(/^#.*$/gm, "").replace(/\s+/g, " ").trim().length;
    if (bodyChars < 80 && !hasClaudeImports && !hasCommand) {
      findings.push({
        ruleIds: [],
        surfaceIds: [surface.id],
        severity: "info",
        category: "structure",
        message: `${surface.path} is empty or boilerplate (${bodyChars} chars of content) — it costs a file read on every session and tells the agent nothing. Fill it in or delete it.`,
        evidence: `"${surface.raw.replace(/\s+/g, " ").trim().slice(0, 120)}"`,
      });
    }

    // 3. Surfaces no known tool loads.
    if (surface.tools.length === 0) {
      findings.push({
        ruleIds: [],
        surfaceIds: [surface.id],
        severity: "info",
        category: "load-semantics",
        message: `${surface.path} is read by no tool ctxlint knows (legacy format; treated as not loaded — assumed). Its rules have no effect: migrate them into .cursor/rules/*.mdc or AGENTS.md, then delete this file.`,
        evidence: `kind: ${surface.kind}`,
      });
    }
  }

  // 4. Rules that point teammates at user-global config they cannot see.
  const surfacesById = new Map(surfaces.map((s) => [s.id, s]));
  for (const rule of rules) {
    if (!rule.text.includes("~/.claude/")) continue;
    const surface = surfacesById.get(rule.surfaceId);
    if (!surface || surface.scope === "user-global") continue;
    findings.push({
      ruleIds: [rule.id],
      surfaceIds: [rule.surfaceId],
      severity: "info",
      category: "load-semantics",
      message: `${surface.path}:${rule.span.startLine}-${rule.span.endLine} references ~/.claude/ — user-global config is not visible to teammates or CI. Move whatever it points at into the repo.`,
      evidence: `"${rule.text.slice(0, 160)}"`,
    });
  }

  return findings;
}
