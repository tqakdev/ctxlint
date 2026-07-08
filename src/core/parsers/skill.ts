import type { Finding, Rule, Surface } from "../model.js";
import { extractBodyRules, parseFrontmatter } from "./frontmatter.js";

/**
 * SKILL.md: YAML frontmatter (name/description) + markdown body. Unlike
 * Cursor's .mdc format, skill frontmatter IS strict YAML — no lenient
 * recovery, a parse failure is genuinely broken.
 */
export function parseSkill(surface: Surface): { rules: Rule[]; findings: Finding[] } {
  const findings: Finding[] = [];
  const parsed = parseFrontmatter(surface.raw);

  if (parsed.yamlError) {
    surface.meta = { ...surface.meta, frontmatterError: parsed.yamlError };
    findings.push({
      ruleIds: [],
      surfaceIds: [surface.id],
      severity: "warn",
      category: "structure",
      message: `${surface.path}:1 has broken frontmatter (${parsed.yamlError}) — the skill's name/description cannot be read. Fix the YAML.`,
      evidence: surface.raw.split("\n").slice(0, 5).join("\n"),
    });
  } else {
    surface.meta = { ...surface.meta, ...parsed.data };
  }

  return { rules: extractBodyRules(surface, parsed.body), findings };
}
