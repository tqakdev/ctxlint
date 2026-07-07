import type { RepoIndex } from "../discovery.js";
import type { EffectiveContext, Surface, ToolId } from "../model.js";
import { resolveClaudeCode } from "./claudeCode.js";
import { resolveCodex, resolveGenericAgentsMd } from "./codex.js";
import { resolveCopilot } from "./copilot.js";
import { cursorRuleDir, resolveCursor } from "./cursor.js";
import { dirOf } from "./shared.js";
import { resolveWindsurf, windsurfRuleDir } from "./windsurf.js";

type Resolver = (surfaces: Surface[], directory: string, index: RepoIndex) => EffectiveContext;

export const RESOLVERS: Record<ToolId, Resolver> = {
  "claude-code": resolveClaudeCode,
  cursor: resolveCursor,
  copilot: resolveCopilot,
  codex: resolveCodex,
  windsurf: resolveWindsurf,
  "generic-agents-md": resolveGenericAgentsMd,
};

export function resolveOne(
  tool: ToolId,
  surfaces: Surface[],
  directory: string,
  index: RepoIndex,
): EffectiveContext {
  return RESOLVERS[tool](surfaces, directory, index);
}

function surfaceKey(context: EffectiveContext): string {
  return context.surfaces.map((e) => e.surface.path).join("|");
}

/**
 * Compute effective contexts for the repo root for every tool, plus for each
 * subtree directory that carries its own surfaces — keeping only subtree
 * contexts that actually differ from the root's for that tool.
 */
export function resolveAll(surfaces: Surface[], index: RepoIndex): EffectiveContext[] {
  const subtreeDirs = new Set<string>();
  for (const surface of surfaces) {
    if (surface.scope !== "subtree") continue;
    const dir =
      surface.kind === "cursor-rule"
        ? cursorRuleDir(surface.path)
        : surface.kind === "windsurf-rule"
          ? windsurfRuleDir(surface.path)
          : dirOf(surface.path);
    subtreeDirs.add(dir);
  }

  const contexts: EffectiveContext[] = [];
  const tools = Object.keys(RESOLVERS) as ToolId[];
  for (const tool of tools) {
    const rootContext = resolveOne(tool, surfaces, ".", index);
    contexts.push(rootContext);
    for (const dir of [...subtreeDirs].sort()) {
      const context = resolveOne(tool, surfaces, dir, index);
      if (surfaceKey(context) !== surfaceKey(rootContext)) contexts.push(context);
    }
  }
  return contexts;
}
