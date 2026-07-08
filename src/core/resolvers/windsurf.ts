import type { RepoIndex } from "../discovery.js";
import type { EffectiveContext, EffectiveContextEntry, Surface } from "../model.js";
import type { WindsurfRuleMeta } from "../parsers/windsurfRule.js";
import { buildContext, dirOf, globActivatesUnder, isAncestorOrSelf } from "./shared.js";

export function windsurfRuleDir(surfacePath: string): string {
  // "packages/web/.windsurf/rules/x.md" attaches to "packages/web".
  const idx = surfacePath.indexOf(".windsurf/rules/");
  if (idx > 0) return surfacePath.slice(0, idx - 1);
  if (idx === 0) return ".";
  // Legacy ".windsurfrules" attaches to its own directory.
  return dirOf(surfacePath);
}

/**
 * Windsurf load semantics (assumed from public docs):
 * - legacy `.windsurfrules` is still read, always-on (deprecated format);
 * - `.windsurf/rules/*.md` activation follows frontmatter `trigger`:
 *   always_on -> always in context; glob -> attaches when the edited file
 *   matches (conditional); manual/model_decision/absent -> conditional.
 */
export function resolveWindsurf(
  surfaces: Surface[],
  directory: string,
  index: RepoIndex,
): EffectiveContext {
  const entries: Omit<EffectiveContextEntry, "order">[] = [];

  const rules = surfaces
    .filter((s) => s.kind === "windsurf-rule" && s.scope !== "user-global")
    .filter((s) => isAncestorOrSelf(windsurfRuleDir(s.path), directory))
    .sort((a, b) => (a.path < b.path ? -1 : 1));

  for (const surface of rules) {
    if (surface.path.endsWith(".windsurfrules")) {
      entries.push({
        surface,
        reason:
          "legacy .windsurfrules — still read by Windsurf, always-on (deprecated; migrate to .windsurf/rules/)",
      });
      continue;
    }
    const meta = (surface.meta ?? {}) as WindsurfRuleMeta;
    if (meta.frontmatterError) {
      entries.push({
        surface,
        reason: "frontmatter unparseable — activation unknown, assumed not auto-attached",
        conditional: true,
      });
    } else if (meta.trigger === "always_on") {
      entries.push({ surface, reason: "trigger: always_on" });
    } else if (meta.trigger === "glob" && meta.globs && meta.globs.length > 0) {
      const active = meta.globs.some((g) => globActivatesUnder(g, directory, index));
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
        reason: `trigger: ${meta.trigger ?? "unset"} — loads on demand only (assumed)`,
        conditional: true,
      });
    }
  }

  return buildContext("windsurf", directory, entries);
}
