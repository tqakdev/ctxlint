import matter from "gray-matter";
import type { Finding, Rule, Surface } from "../model.js";
import { parseAgentsMd } from "./agentsMd.js";
import { normalizeGlobs, stripBrokenFrontmatter } from "./cursorRule.js";
import { extractRules } from "./markdown.js";

export type WindsurfTrigger = "always_on" | "manual" | "model_decision" | "glob";

export interface WindsurfRuleMeta {
  description?: string;
  trigger?: WindsurfTrigger;
  globs?: string[];
  frontmatterError?: string;
}

const TRIGGERS = new Set<string>(["always_on", "manual", "model_decision", "glob"]);

/**
 * Windsurf rules come in two shapes:
 * - legacy `.windsurfrules`: plain markdown, no frontmatter (deprecated);
 * - `.windsurf/rules/*.md`: YAML frontmatter (trigger/globs) + markdown body.
 */
export function parseWindsurfRule(surface: Surface): { rules: Rule[]; findings: Finding[] } {
  if (surface.path.endsWith(".windsurfrules")) return parseAgentsMd(surface);

  const findings: Finding[] = [];
  let body = surface.raw;
  const meta: WindsurfRuleMeta = {};

  try {
    // Options object disables gray-matter's content-keyed cache (see cursorRule.ts).
    const parsed = matter(surface.raw, {});
    body = parsed.content;
    const data = parsed.data as Record<string, unknown>;
    if (typeof data.description === "string") meta.description = data.description;
    if (typeof data.trigger === "string" && TRIGGERS.has(data.trigger)) {
      meta.trigger = data.trigger as WindsurfTrigger;
    }
    const globs = normalizeGlobs(data.globs);
    if (globs) meta.globs = globs;
  } catch (error) {
    const message = (error as Error).message.split("\n")[0] ?? "unparseable YAML";
    meta.frontmatterError = message;
    body = stripBrokenFrontmatter(surface.raw);
    findings.push({
      ruleIds: [],
      surfaceIds: [surface.id],
      severity: "warn",
      category: "structure",
      message: `${surface.path}:1 has broken frontmatter (${message}) — Windsurf cannot read its activation config (trigger/globs), so these rules may never load. Fix the YAML.`,
      evidence: surface.raw.split("\n").slice(0, 5).join("\n"),
    });
  }

  surface.meta = { ...surface.meta, ...meta };

  // Rebuild positions against the original file (see cursorRule.ts).
  const offset = surface.raw.split("\n").length - body.split("\n").length;
  const rules = extractRules({ ...surface, raw: body }).map((rule) => ({
    ...rule,
    span: {
      startLine: rule.span.startLine + offset,
      endLine: rule.span.endLine + offset,
    },
  }));

  return { rules, findings };
}
