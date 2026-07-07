import type { RepoIndex } from "../discovery.js";
import type { EffectiveContext, EffectiveContextEntry, Surface } from "../model.js";
import { buildContext, chainFor, describeScope } from "./shared.js";

/**
 * GitHub Copilot load semantics (v1):
 * - .github/copilot-instructions.md applies repo-wide;
 * - reads AGENTS.md (nested AGENTS.md support marked as assumed).
 */
export function resolveCopilot(
  surfaces: Surface[],
  directory: string,
  _index: RepoIndex,
): EffectiveContext {
  const entries: Omit<EffectiveContextEntry, "order">[] = [];

  const instructions = surfaces.find((s) => s.kind === "copilot-instructions");
  if (instructions) {
    entries.push({ surface: instructions, reason: "repo-wide copilot-instructions.md" });
  }
  for (const surface of chainFor(surfaces, "agents-md", directory)) {
    const scope = describeScope(surface, directory);
    entries.push({
      surface,
      reason:
        scope === "repo root"
          ? "AGENTS.md at repo root — Copilot reads AGENTS.md"
          : `AGENTS.md at ${scope} (nested AGENTS.md support assumed)`,
    });
  }

  return buildContext("copilot", directory, entries);
}
