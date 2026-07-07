/**
 * Minimal glob matching for staleness checks and resolver activation. Kept
 * dependency-free so analyzers stay pure; supports the forms that appear in
 * context files: `**`, `*`, `?`, and literal paths.
 */

const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g;

export function globToRegExp(glob: string): RegExp {
  let out = "^";
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
    } else {
      out += char.replace(REGEX_SPECIALS, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`${out}$`);
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
