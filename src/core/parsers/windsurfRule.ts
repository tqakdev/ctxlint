import type { Finding, Rule, Surface } from "../model.js";
import { parseAgentsMd } from "./agentsMd.js";
import { normalizeGlobs } from "./cursorRule.js";
import { extractBodyRules, type LenientSpec, parseFrontmatter } from "./frontmatter.js";

export type WindsurfTrigger = "always_on" | "manual" | "model_decision" | "glob";

export interface WindsurfRuleMeta {
  description?: string;
  trigger?: WindsurfTrigger;
  globs?: string[];
  frontmatterError?: string;
}

const TRIGGERS = new Set<string>(["always_on", "manual", "model_decision", "glob"]);

/** Like Cursor, Windsurf rule files carry unquoted globs that strict YAML rejects. */
const WINDSURF_LENIENT: LenientSpec = {
  description: /^.*$/,
  trigger: /^(?:always_on|manual|model_decision|glob)$/,
  globs: /^[\w@*?./{}, -]*$/,
};

/**
 * Windsurf rules come in two shapes:
 * - legacy `.windsurfrules`: plain markdown, no frontmatter (deprecated);
 * - `.windsurf/rules/*.md`: YAML frontmatter (trigger/globs) + markdown body.
 */
export function parseWindsurfRule(surface: Surface): { rules: Rule[]; findings: Finding[] } {
  if (surface.path.endsWith(".windsurfrules")) return parseAgentsMd(surface);

  const findings: Finding[] = [];
  const parsed = parseFrontmatter(surface.raw, WINDSURF_LENIENT);
  const meta: WindsurfRuleMeta = {};

  if (typeof parsed.data.description === "string") meta.description = parsed.data.description;
  if (typeof parsed.data.trigger === "string" && TRIGGERS.has(parsed.data.trigger)) {
    meta.trigger = parsed.data.trigger as WindsurfTrigger;
  }
  const globs = normalizeGlobs(parsed.data.globs);
  if (globs) meta.globs = globs;

  if (parsed.yamlError && !parsed.lenient) {
    meta.frontmatterError = parsed.yamlError;
    findings.push({
      ruleIds: [],
      surfaceIds: [surface.id],
      severity: "warn",
      category: "structure",
      message: `${surface.path}:1 has broken frontmatter (${parsed.yamlError}) — Windsurf cannot read its activation config (trigger/globs), so these rules may never load. Fix the YAML.`,
      evidence: surface.raw.split("\n").slice(0, 5).join("\n"),
    });
  }

  surface.meta = { ...surface.meta, ...meta };
  return { rules: extractBodyRules(surface, parsed.body), findings };
}
