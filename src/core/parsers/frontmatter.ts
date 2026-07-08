import matter from "gray-matter";
import type { Rule, Surface } from "../model.js";
import { extractRules } from "./markdown.js";

/**
 * Shared frontmatter handling for .mdc / .windsurf rules / SKILL.md surfaces:
 * strict YAML first, then (where the tool's own format is not strict YAML) a
 * lenient line-based recovery, and span bookkeeping so rule positions always
 * point into the original file.
 */

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
  /** First line of the strict-YAML error, when strict parsing failed. */
  yamlError?: string;
  /** True when `data` was recovered by the lenient line parser. */
  lenient: boolean;
}

/**
 * Per-key value validators for lenient recovery. Recovery succeeds only when
 * every non-blank frontmatter line is a known key with a plausible value —
 * anything else is treated as genuinely broken.
 */
export type LenientSpec = Record<string, RegExp>;

/**
 * Strip a frontmatter block by hand when the YAML is unparseable, so we can
 * still extract rules from the body instead of treating delimiters as prose.
 */
export function stripBrokenFrontmatter(raw: string): string {
  const lines = raw.split("\n");
  if (!/^-{3}\s*$/.test(lines[0] ?? "")) return raw;
  for (let i = 1; i < lines.length; i++) {
    if (/^-{2,}\s*$/.test(lines[i] ?? "")) {
      return lines.slice(i + 1).join("\n");
    }
  }
  return raw;
}

/**
 * Line-based `key: value` recovery for frontmatter that fails strict YAML but
 * is valid in the tool's own format — Cursor generates `globs: *.ts`
 * unquoted, which YAML rejects as an alias node while Cursor reads it fine.
 */
function parseLenient(raw: string, spec: LenientSpec): Record<string, unknown> | undefined {
  const lines = raw.split("\n");
  if (!/^-{3}\s*$/.test(lines[0] ?? "")) return undefined;
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^-{3}\s*$/.test(lines[i] ?? "")) {
      close = i;
      break;
    }
  }
  if (close === -1) return undefined;

  const data: Record<string, unknown> = {};
  for (const line of lines.slice(1, close)) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (!kv) return undefined;
    const key = kv[1] as string;
    const value = kv[2] as string;
    if (!spec[key]?.test(value)) return undefined;
    data[key] = value === "true" ? true : value === "false" ? false : value;
  }
  return Object.keys(data).length > 0 ? data : undefined;
}

export function parseFrontmatter(raw: string, lenientSpec?: LenientSpec): ParsedFrontmatter {
  try {
    // Pass an options object: gray-matter's content-keyed cache stores the file
    // BEFORE parsing, so a second parse of broken frontmatter would silently
    // succeed from cache. Options disable the cache and keep scans deterministic.
    const parsed = matter(raw, {});
    return { data: parsed.data as Record<string, unknown>, body: parsed.content, lenient: false };
  } catch (error) {
    const yamlError = (error as Error).message.split("\n")[0] ?? "unparseable YAML";
    const recovered = lenientSpec ? parseLenient(raw, lenientSpec) : undefined;
    if (recovered) {
      return { data: recovered, body: stripBrokenFrontmatter(raw), yamlError, lenient: true };
    }
    return { data: {}, body: stripBrokenFrontmatter(raw), yamlError, lenient: false };
  }
}

/**
 * Extract rules from the post-frontmatter body with spans mapped back to the
 * original file (rules start after the stripped frontmatter lines).
 */
export function extractBodyRules(surface: Surface, body: string): Rule[] {
  const offset = surface.raw.split("\n").length - body.split("\n").length;
  return extractRules({ ...surface, raw: body }).map((rule) => ({
    ...rule,
    span: {
      startLine: rule.span.startLine + offset,
      endLine: rule.span.endLine + offset,
    },
  }));
}
