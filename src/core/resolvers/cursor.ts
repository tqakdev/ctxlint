import type { RepoIndex } from "../discovery.js";
import type { EffectiveContext, EffectiveContextEntry, Surface } from "../model.js";
import type { CursorRuleMeta } from "../parsers/cursorRule.js";
import {
  buildContext,
  chainFor,
  describeScope,
  dirOf,
  globActivatesUnder,
  isAncestorOrSelf,
} from "./shared.js";

function cursorRuleDir(surfacePath: string): string {
  // "packages/web/.cursor/rules/x.mdc" attaches to "packages/web".
  const idx = surfacePath.indexOf(".cursor/rules/");
  if (idx <= 0) return ".";
  return surfacePath.slice(0, idx - 1);
}

/**
 * Cursor load semantics (v1):
 * - .cursor/rules/*.mdc with frontmatter: alwaysApply rules are always in
 *   context; glob rules attach when the edited file matches (reported as
 *   conditional); rules with neither are agent-requested (conditional, assumed);
 * - AGENTS.md is treated as rules-equivalent;
 * - legacy .cursorrules is deprecated and treated as not loaded (assumed) —
 *   flagged separately by the structure analyzer.
 */
export function resolveCursor(
  surfaces: Surface[],
  directory: string,
  index: RepoIndex,
): EffectiveContext {
  const entries: Omit<EffectiveContextEntry, "order">[] = [];

  for (const surface of chainFor(surfaces, "agents-md", directory)) {
    entries.push({
      surface,
      reason: `AGENTS.md at ${describeScope(surface, directory)} — Cursor treats AGENTS.md as rules-equivalent`,
    });
  }

  const rules = surfaces
    .filter((s) => s.kind === "cursor-rule")
    .filter((s) => isAncestorOrSelf(cursorRuleDir(s.path), directory))
    .sort((a, b) => (a.path < b.path ? -1 : 1));

  for (const surface of rules) {
    const meta = (surface.meta ?? {}) as CursorRuleMeta;
    if (meta.frontmatterError) {
      entries.push({
        surface,
        reason: `frontmatter unparseable — activation unknown, assumed not auto-attached`,
        conditional: true,
      });
    } else if (meta.alwaysApply) {
      entries.push({ surface, reason: "alwaysApply: true" });
    } else if (meta.globs && meta.globs.length > 0) {
      const ruleDir = cursorRuleDir(surface.path);
      const active = meta.globs.some((g) => globActivatesUnder(g, ruleDir, directory, index));
      entries.push({
        surface,
        reason: active
          ? `activates for files matching ${meta.globs.map((g) => `\`${g}\``).join(", ")} (conditional)`
          : `globs ${meta.globs.map((g) => `\`${g}\``).join(", ")} match nothing under ${directory} (conditional)`,
        conditional: true,
      });
    } else {
      entries.push({
        surface,
        reason: "no alwaysApply/globs — agent-requested only (assumed)",
        conditional: true,
      });
    }
  }

  return buildContext("cursor", directory, entries);
}

export { cursorRuleDir, dirOf };
