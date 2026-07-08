import type { Finding, Rule, Surface } from "../model.js";
import { extractBodyRules, type LenientSpec, parseFrontmatter } from "./frontmatter.js";

export interface CursorRuleMeta {
  description?: string;
  globs?: string[];
  alwaysApply?: boolean;
  frontmatterError?: string;
}

export function normalizeGlobs(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    // Split on commas, but never inside {ts,tsx} alternation braces.
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < value.length; i++) {
      const char = value[i];
      if (char === "{") depth += 1;
      else if (char === "}") depth = Math.max(0, depth - 1);
      else if (char === "," && depth === 0) {
        parts.push(value.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(value.slice(start));
    return parts.map((g) => g.trim()).filter((g) => g !== "");
  }
  return undefined;
}

/**
 * Cursor's own .mdc format is not strict YAML: its editor writes globs
 * unquoted (`globs: *.ts`), which YAML rejects as an alias node while
 * Cursor reads it fine. Recover those keys leniently and reserve the
 * broken-frontmatter finding for files even Cursor could not read.
 */
const CURSOR_LENIENT: LenientSpec = {
  description: /^.*$/,
  globs: /^[\w@*?./{}, -]*$/,
  alwaysApply: /^(?:true|false)$/,
};

/** .cursor/rules/*.mdc: YAML frontmatter (globs/alwaysApply) + markdown body. */
export function parseCursorRule(surface: Surface): { rules: Rule[]; findings: Finding[] } {
  const findings: Finding[] = [];
  const parsed = parseFrontmatter(surface.raw, CURSOR_LENIENT);
  const meta: CursorRuleMeta = {};

  if (typeof parsed.data.description === "string") meta.description = parsed.data.description;
  const globs = normalizeGlobs(parsed.data.globs);
  if (globs) meta.globs = globs;
  if (typeof parsed.data.alwaysApply === "boolean") meta.alwaysApply = parsed.data.alwaysApply;

  if (parsed.yamlError && !parsed.lenient) {
    meta.frontmatterError = parsed.yamlError;
    findings.push({
      ruleIds: [],
      surfaceIds: [surface.id],
      severity: "warn",
      category: "structure",
      message: `${surface.path}:1 has broken frontmatter (${parsed.yamlError}) — Cursor cannot read its activation config (globs/alwaysApply), so these rules may never load. Fix the YAML.`,
      evidence: surface.raw.split("\n").slice(0, 5).join("\n"),
    });
  }

  surface.meta = { ...surface.meta, ...meta };
  return { rules: extractBodyRules(surface, parsed.body), findings };
}
