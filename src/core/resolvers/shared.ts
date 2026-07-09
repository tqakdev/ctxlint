import type { RepoIndex } from "../discovery.js";
import { globToRegExp } from "../glob.js";
import type { EffectiveContext, EffectiveContextEntry, Surface, ToolId } from "../model.js";

/**
 * Does `glob` match any indexed file under `directory`? (Activation check.)
 * For rules attached below the repo root, tool docs don't specify whether
 * globs resolve against the repo root or the rule's own directory — so a
 * glob activates under EITHER reading (recorded as an assumption in
 * TOOL_BEHAVIOR). `ruleDir` is always an ancestor-or-self of `directory`.
 */
export function globActivatesUnder(
  glob: string,
  ruleDir: string,
  directory: string,
  index: RepoIndex,
): boolean {
  const re = globToRegExp(glob);
  const prefix = directory === "." ? "" : `${directory}/`;
  const strip = ruleDir === "." ? 0 : ruleDir.length + 1;
  return index.files.some((f) => {
    if (!f.startsWith(prefix)) return false;
    if (re.test(f)) return true;
    return strip > 0 && f.startsWith(`${ruleDir}/`) && re.test(f.slice(strip));
  });
}

export function dirOf(surfacePath: string): string {
  const idx = surfacePath.lastIndexOf("/");
  return idx === -1 ? "." : surfacePath.slice(0, idx);
}

/** Is `ancestor` equal to or an ancestor directory of `dir`? ("." is everyone's ancestor.) */
export function isAncestorOrSelf(ancestor: string, dir: string): boolean {
  if (ancestor === ".") return true;
  return dir === ancestor || dir.startsWith(`${ancestor}/`);
}

/**
 * Surfaces of `kind` that apply when working in `directory`, ordered from the
 * repo root down to the directory (broader context first).
 */
export function chainFor(surfaces: Surface[], kind: Surface["kind"], directory: string): Surface[] {
  return surfaces
    .filter((s) => s.kind === kind && s.scope !== "user-global")
    .filter((s) => isAncestorOrSelf(dirOf(s.path), directory))
    .sort(
      (a, b) => a.path.split("/").length - b.path.split("/").length || (a.path < b.path ? -1 : 1),
    );
}

export function buildContext(
  tool: ToolId,
  directory: string,
  entries: Omit<EffectiveContextEntry, "order">[],
): EffectiveContext {
  const ordered = entries.map((entry, i) => ({ ...entry, order: i + 1 }));
  let total = 0;
  let conditional = 0;
  for (const entry of ordered) {
    if (entry.conditional) conditional += entry.surface.tokensEstimated;
    else total += entry.surface.tokensEstimated;
  }
  return {
    tool,
    directory,
    surfaces: ordered,
    totalTokensEstimated: total,
    conditionalTokensEstimated: conditional,
  };
}

export function describeScope(surface: Surface, directory: string): string {
  const dir = dirOf(surface.path);
  if (surface.scope === "user-global") return "user-global (not visible to teammates)";
  if (dir === ".") return "repo root";
  if (dir === directory) return `this directory (${dir})`;
  return `ancestor directory ${dir}`;
}
