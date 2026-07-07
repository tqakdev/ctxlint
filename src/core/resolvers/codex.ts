import type { RepoIndex } from "../discovery.js";
import type { EffectiveContext, EffectiveContextEntry, Surface, ToolId } from "../model.js";
import { buildContext, chainFor, describeScope } from "./shared.js";

/**
 * Codex / generic AGENTS.md load semantics (v1): the AGENTS.md hierarchy from
 * the repo root down to the working directory.
 */
function resolveAgentsHierarchy(
  tool: ToolId,
  surfaces: Surface[],
  directory: string,
): EffectiveContext {
  const entries: Omit<EffectiveContextEntry, "order">[] = [];
  for (const surface of chainFor(surfaces, "agents-md", directory)) {
    entries.push({
      surface,
      reason: `AGENTS.md at ${describeScope(surface, directory)} (root → cwd hierarchy)`,
    });
  }
  return buildContext(tool, directory, entries);
}

export function resolveCodex(
  surfaces: Surface[],
  directory: string,
  _index: RepoIndex,
): EffectiveContext {
  return resolveAgentsHierarchy("codex", surfaces, directory);
}

export function resolveGenericAgentsMd(
  surfaces: Surface[],
  directory: string,
  _index: RepoIndex,
): EffectiveContext {
  return resolveAgentsHierarchy("generic-agents-md", surfaces, directory);
}
