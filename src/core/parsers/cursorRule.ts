import matter from "gray-matter";
import type { Finding, Rule, Surface } from "../model.js";
import { extractRules } from "./markdown.js";

export interface CursorRuleMeta {
  description?: string;
  globs?: string[];
  alwaysApply?: boolean;
  frontmatterError?: string;
}

function normalizeGlobs(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    return value
      .split(",")
      .map((g) => g.trim())
      .filter((g) => g !== "");
  }
  return undefined;
}

/**
 * Strip a frontmatter block by hand when the YAML is unparseable, so we can
 * still extract rules from the body instead of treating delimiters as prose.
 */
function stripBrokenFrontmatter(raw: string): string {
  const lines = raw.split("\n");
  if (!/^-{3}\s*$/.test(lines[0] ?? "")) return raw;
  for (let i = 1; i < lines.length; i++) {
    if (/^-{2,}\s*$/.test(lines[i] ?? "")) {
      return lines.slice(i + 1).join("\n");
    }
  }
  return raw;
}

/** .cursor/rules/*.mdc: YAML frontmatter (globs/alwaysApply) + markdown body. */
export function parseCursorRule(surface: Surface): { rules: Rule[]; findings: Finding[] } {
  const findings: Finding[] = [];
  let body = surface.raw;
  const meta: CursorRuleMeta = {};

  try {
    // Pass an options object: gray-matter's content-keyed cache stores the file
    // BEFORE parsing, so a second parse of broken frontmatter would silently
    // succeed from cache. Options disable the cache and keep scans deterministic.
    const parsed = matter(surface.raw, {});
    body = parsed.content;
    const data = parsed.data as Record<string, unknown>;
    if (typeof data.description === "string") meta.description = data.description;
    const globs = normalizeGlobs(data.globs);
    if (globs) meta.globs = globs;
    if (typeof data.alwaysApply === "boolean") meta.alwaysApply = data.alwaysApply;
  } catch (error) {
    const message = (error as Error).message.split("\n")[0] ?? "unparseable YAML";
    meta.frontmatterError = message;
    body = stripBrokenFrontmatter(surface.raw);
    findings.push({
      ruleIds: [],
      surfaceIds: [surface.id],
      severity: "warn",
      category: "structure",
      message: `${surface.path}:1 has broken frontmatter (${message}) — Cursor cannot read its activation config (globs/alwaysApply), so these rules may never load. Fix the YAML.`,
      evidence: surface.raw.split("\n").slice(0, 5).join("\n"),
    });
  }

  surface.meta = { ...surface.meta, ...meta };

  // Rebuild positions against the original file: rules parsed from the body
  // start after the stripped frontmatter, so offset spans by the strip length.
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
