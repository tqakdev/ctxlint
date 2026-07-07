import type { RepoIndex } from "../discovery.js";
import type { EffectiveContext, EffectiveContextEntry, Surface } from "../model.js";
import { buildContext, chainFor, describeScope } from "./shared.js";

/**
 * Claude Code load semantics (v1):
 * - user-global ~/.claude/CLAUDE.md, then CLAUDE.md files from the repo root
 *   down to the working directory (subdirectory CLAUDE.md applies to work in
 *   that subtree);
 * - also reads AGENTS.md along the same hierarchy (documented behavior; the
 *   relative injection order vs CLAUDE.md is marked as assumed);
 * - skills load on demand, so they are inventoried but not counted here.
 */
export function resolveClaudeCode(
  surfaces: Surface[],
  directory: string,
  _index: RepoIndex,
): EffectiveContext {
  const entries: Omit<EffectiveContextEntry, "order">[] = [];

  const userGlobal = surfaces.find((s) => s.scope === "user-global" && s.kind === "claude-md");
  if (userGlobal) {
    entries.push({
      surface: userGlobal,
      reason: "user-global CLAUDE.md — loaded for every repo; not visible to teammates",
    });
  }

  for (const surface of chainFor(surfaces, "claude-md", directory)) {
    entries.push({ surface, reason: `CLAUDE.md at ${describeScope(surface, directory)}` });
  }
  for (const surface of chainFor(surfaces, "agents-md", directory)) {
    entries.push({
      surface,
      reason: `AGENTS.md at ${describeScope(surface, directory)} — Claude Code reads AGENTS.md alongside CLAUDE.md (order assumed)`,
    });
  }

  return buildContext("claude-code", directory, entries);
}
