/**
 * Minimal glob matching for staleness checks and resolver activation. Kept
 * dependency-free so analyzers stay pure; supports the forms that appear in
 * context files: `**`, `*`, `?`, `{a,b}` alternation, and literal paths.
 */

const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g;

/**
 * Compiled-pattern memo: resolvers test the same handful of .mdc globs against
 * the file list once per (tool, directory) pair, so compile each pattern once
 * per process instead of once per call.
 */
const compiled = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const cached = compiled.get(glob);
  if (cached) return cached;
  const re = new RegExp(`^${compileSource(glob)}$`);
  compiled.set(glob, re);
  return re;
}

/** Index of the `}` closing the brace at `open` (depth-aware), or -1. */
function braceEnd(glob: string, open: number): number {
  let depth = 0;
  for (let i = open; i < glob.length; i++) {
    if (glob[i] === "{") depth += 1;
    else if (glob[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

/** Split a brace body on top-level commas: "a,{b,c}" -> ["a", "{b,c}"]. */
function splitAlternatives(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "{") depth += 1;
    else if (body[i] === "}") depth -= 1;
    else if (body[i] === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

function compileSource(glob: string): string {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const char = glob[i] as string;
    if (char === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more path segments; trailing `**` matches everything.
        if (glob[i + 2] === "/") {
          out += "(?:[^/]+/)*";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (char === "?") {
      out += "[^/]";
      i += 1;
    } else if (char === "{") {
      // `{ts,tsx}` alternation — routine in .mdc/.windsurf frontmatter globs.
      // An unclosed `{` stays a literal character.
      const end = braceEnd(glob, i);
      if (end === -1) {
        out += "\\{";
        i += 1;
      } else {
        const alternatives = splitAlternatives(glob.slice(i + 1, end));
        out += `(?:${alternatives.map(compileSource).join("|")})`;
        i = end + 1;
      }
    } else {
      out += char.replace(REGEX_SPECIALS, "\\$&");
      i += 1;
    }
  }
  return out;
}

/**
 * Does `pattern` match any of `files` (repo-relative posix paths)?
 * Patterns without a `/` match against basenames, mirroring common usage
 * like `*.test.ts` meaning "files named *.test.ts anywhere".
 */
export function globMatchesAny(pattern: string, files: readonly string[]): boolean {
  const re = globToRegExp(pattern);
  if (pattern.includes("/")) {
    return files.some((f) => re.test(f));
  }
  return files.some((f) => {
    const base = f.slice(f.lastIndexOf("/") + 1);
    return re.test(base);
  });
}
