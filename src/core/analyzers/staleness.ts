import { globMatchesAny } from "../glob.js";
import type { Finding, Rule, Surface } from "../model.js";

/**
 * Pure repo facts the staleness analyzer needs, assembled by the I/O layer
 * (discovery) so this module never touches the filesystem.
 */
export interface RepoFacts {
  files: readonly string[];
  fileSet: ReadonlySet<string>;
  dirSet: ReadonlySet<string>;
  scriptsByDir: ReadonlyMap<string, ReadonlySet<string>>;
  truncated: boolean;
}

function surfaceDir(surfacePath: string): string {
  const idx = surfacePath.lastIndexOf("/");
  return idx === -1 ? "." : surfacePath.slice(0, idx);
}

function join(dir: string, rel: string): string {
  return dir === "." ? rel : `${dir}/${rel}`;
}

function pathExists(ref: string, dir: string, facts: RepoFacts): boolean {
  const candidates = dir === "." ? [ref] : [join(dir, ref), ref];
  for (const raw of candidates) {
    const candidate = raw.replace(/^\.\//, "").replace(/\/$/, "");
    if (facts.fileSet.has(candidate) || facts.dirSet.has(candidate)) return true;
  }
  return false;
}

function globExists(ref: string, dir: string, facts: RepoFacts): boolean {
  if (globMatchesAny(ref, facts.files)) return true;
  if (dir !== "." && ref.includes("/")) {
    return globMatchesAny(join(dir, ref), facts.files);
  }
  return false;
}

/** Nearest package.json scripts, walking up from the surface's directory. */
function scriptsFor(dir: string, facts: RepoFacts): ReadonlySet<string> | undefined {
  let current = dir;
  for (;;) {
    const scripts = facts.scriptsByDir.get(current);
    if (scripts) return scripts;
    if (current === ".") return undefined;
    const idx = current.lastIndexOf("/");
    current = idx === -1 ? "." : current.slice(0, idx);
  }
}

const HAS_EXTENSION = /\.[a-z0-9]{1,10}$/i;

/**
 * Slash tokens with no extension, no trailing slash, and no ./ prefix might be
 * prose ("try/catch", "read/write") rather than paths. Only treat them as path
 * claims when their first segment is a real directory in this repo.
 */
function isCredibleWeakRef(ref: string, dir: string, facts: RepoFacts): boolean {
  const first = ref.split("/")[0] as string;
  return facts.dirSet.has(first) || (dir !== "." && facts.dirSet.has(`${dir}/${first}`));
}

/**
 * Every referencedPaths entry must exist in the repo. Missing paths are
 * errors: a rule pointing at something that isn't there is actively
 * misleading the agent on every request.
 */
export function analyzeStaleness(
  rules: Rule[],
  surfaces: Map<string, Surface>,
  facts: RepoFacts,
): Finding[] {
  const findings: Finding[] = [];
  for (const rule of rules) {
    const surface = surfaces.get(rule.surfaceId);
    if (!surface || surface.scope === "user-global") continue;
    const dir = surfaceDir(surface.path);
    for (const ref of rule.referencedPaths) {
      const weak =
        !ref.startsWith("npm run ") &&
        !ref.includes("*") &&
        !ref.includes("?") &&
        !ref.endsWith("/") &&
        !ref.startsWith("./") &&
        !HAS_EXTENSION.test(ref);
      if (weak && !isCredibleWeakRef(ref, dir, facts)) continue;
      let exists: boolean;
      let what: string;
      if (ref.startsWith("npm run ")) {
        const script = ref.slice("npm run ".length);
        const scripts = scriptsFor(dir, facts);
        exists = scripts?.has(script) ?? false;
        what = `the npm script "${script}"`;
        if (!scripts) continue; // No package.json found — can't judge.
      } else if (ref.includes("*") || ref.includes("?")) {
        exists = globExists(ref, dir, facts);
        what = `files matching \`${ref}\``;
      } else {
        exists = pathExists(ref, dir, facts);
        what = `\`${ref}\``;
      }
      if (exists) continue;
      const suffix = facts.truncated
        ? " (note: the file index was truncated, so this may be a false alarm — re-run with a higher --max-files)"
        : "";
      findings.push({
        ruleIds: [rule.id],
        surfaceIds: [rule.surfaceId],
        severity: "error",
        category: "stale-reference",
        message: `${surface.path}:${rule.span.startLine}-${rule.span.endLine} references ${what} which does not exist — actively misleading the agent. Update the reference or delete the rule.${suffix}`,
        evidence: `"${rule.text.length > 160 ? `${rule.text.slice(0, 157)}…` : rule.text}"`,
        fix: {
          kind: "update-path",
          description: `Point the reference at the current location of ${what}, or delete it if the thing is gone for good.`,
        },
      });
    }
  }
  return findings;
}
