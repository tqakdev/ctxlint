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

/** Resolve "." / ".." segments; null when the path escapes the repo root. */
function normalizeSegments(p: string): string | null {
  const out: string[] = [];
  for (const segment of p.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(segment);
    }
  }
  return out.join("/");
}

/**
 * Resolution bases for a surface's references, most specific first: the
 * surface's own directory, every ancestor up to the repo root (nested
 * AGENTS.md files routinely write paths relative to their package root),
 * and any `cd <dir>` named in the rule itself (command blocks resolve
 * subsequent paths relative to that directory).
 */
function basesFor(dir: string, ruleText: string): string[] {
  const bases = [dir];
  let current = dir;
  while (current !== ".") {
    const idx = current.lastIndexOf("/");
    current = idx === -1 ? "." : current.slice(0, idx);
    bases.push(current);
  }
  for (const match of ruleText.matchAll(/\bcd\s+([\w@./-]+)/g)) {
    bases.push((match[1] as string).replace(/\/$/, ""));
  }
  return [...new Set(bases)];
}

/** Extensions tried for import-specifier-style refs ("./native-request"). */
const COMPLETION_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".md",
];

function pathExists(ref: string, bases: string[], facts: RepoFacts): boolean {
  // "sdk" + "./X" must become "sdk/X" and "a/b" + "../X" must become "a/X",
  // else ./- and ../-prefixed references from subdirectory surfaces can never
  // resolve (found on the cline and opencode benchmark repos).
  const completable = !HAS_EXTENSION.test(ref) && !ref.endsWith("/");
  let judgeable = false;
  for (const base of bases) {
    const raw = base === "." ? ref : join(base, ref);
    const candidate = normalizeSegments(raw.replace(/\/$/, ""));
    if (candidate === null) continue; // escapes the repo from this base
    judgeable = true;
    if (candidate === "" || facts.fileSet.has(candidate) || facts.dirSet.has(candidate)) {
      return true;
    }
    if (completable) {
      for (const ext of COMPLETION_EXTENSIONS) {
        if (facts.fileSet.has(candidate + ext)) return true;
      }
    }
  }
  // Escapes the repo from every base — unjudgeable, so never flag it.
  return !judgeable;
}

function globExists(ref: string, bases: string[], facts: RepoFacts): boolean {
  for (const base of bases) {
    const pattern = base === "." ? ref : join(base, ref);
    if (globMatchesAny(pattern, facts.files)) return true;
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
  // A slash-less filename that exists anywhere in the repo is findable by
  // name — "each component has a service.py" is a convention, not a location.
  let basenames: Set<string> | null = null;
  const basenameExists = (name: string): boolean => {
    basenames ??= new Set(facts.files.map((f) => f.slice(f.lastIndexOf("/") + 1)));
    return basenames.has(name);
  };
  for (const rule of rules) {
    const surface = surfaces.get(rule.surfaceId);
    if (!surface || surface.scope === "user-global") continue;
    const dir = surfaceDir(surface.path);
    const bases = basesFor(dir, rule.text);
    // Docs in package roots conventionally omit the src/ prefix
    // ("protocols/utils/tool-stream.ts" for packages/llm/src/protocols/…).
    for (const base of [...bases]) {
      const srcDir = base === "." ? "src" : `${base}/src`;
      if (facts.dirSet.has(srcDir)) bases.push(srcDir);
    }
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
        // Slash-namespace tokens (GitHub Action owners `actions/*`, MIME types
        // `text/*`, event names `raw/*`) and directory-less extension globs
        // (`*.orig`) are pattern mentions, not location claims: only judge
        // globs anchored in a directory that exists in this repo.
        if (!ref.includes("/") || !isCredibleWeakRef(ref, dir, facts)) continue;
        exists = globExists(ref, bases, facts);
        what = `files matching \`${ref}\``;
      } else {
        exists = pathExists(ref, bases, facts) || (!ref.includes("/") && basenameExists(ref));
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
          ref,
          description: `Point the reference at the current location of ${what}, or delete it if the thing is gone for good.`,
        },
      });
    }
  }
  return findings;
}
