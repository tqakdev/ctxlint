import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { Finding, Surface, SurfaceKind, SurfaceScope, ToolId } from "./model.js";
import { estimateTokens } from "./tokens.js";

export interface RepoIndex {
  /** Repo-relative posix paths of every non-ignored file (may be truncated). */
  files: string[];
  fileSet: Set<string>;
  /** Every directory (repo-relative posix, no trailing slash) implied by files. */
  dirSet: Set<string>;
  /** Directory (posix, "." for root) -> npm script names from its package.json. */
  scriptsByDir: Map<string, Set<string>>;
  /** True when the walk stopped at maxFiles. */
  truncated: boolean;
}

export interface DiscoveryResult {
  surfaces: Surface[];
  index: RepoIndex;
  findings: Finding[];
}

export interface DiscoverOptions {
  root: string;
  maxFiles: number;
  maxSurfaceBytes: number;
  /** Directory holding user-global config (e.g. ~/.claude); null disables. */
  userGlobalDir?: string | null;
}

const SURFACE_PATTERNS = [
  "**/AGENTS.md",
  "**/CLAUDE.md",
  "**/.cursor/rules/*.mdc",
  ".github/copilot-instructions.md",
  "**/.cursorrules",
  "**/.claude/skills/*/SKILL.md",
];

const ALWAYS_IGNORED = ["**/.git/**", "**/node_modules/**", "**/.ctxlint-cache/**"];

export function surfaceId(surfacePath: string): string {
  return createHash("sha1").update(surfacePath).digest("hex").slice(0, 10);
}

export function classifySurface(relPath: string): { kind: SurfaceKind; tools: ToolId[] } {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  if (base === "AGENTS.md") {
    return { kind: "agents-md", tools: ["claude-code", "cursor", "copilot", "codex", "generic-agents-md"] };
  }
  if (base === "CLAUDE.md") return { kind: "claude-md", tools: ["claude-code"] };
  if (relPath.endsWith(".mdc")) return { kind: "cursor-rule", tools: ["cursor"] };
  if (relPath === ".github/copilot-instructions.md") {
    return { kind: "copilot-instructions", tools: ["copilot"] };
  }
  if (base === "SKILL.md") return { kind: "skill", tools: ["claude-code"] };
  // .cursorrules: legacy Cursor format, deprecated. Treated as loaded by no
  // current tool (confidence: assumed) so it surfaces as a load-semantics finding.
  return { kind: "other", tools: [] };
}

function scopeOf(relPath: string, kind: SurfaceKind): SurfaceScope {
  const depth = relPath.split("/").length;
  switch (kind) {
    case "agents-md":
    case "claude-md":
      return depth === 1 ? "repo-root" : "subtree";
    case "cursor-rule":
      // ".cursor/rules/x.mdc" is depth 3 at the root.
      return depth === 3 ? "repo-root" : "subtree";
    default:
      return "repo-root";
  }
}

/** Convert root .gitignore lines into fast-glob ignore patterns (best effort). */
export function gitignoreToGlobs(gitignore: string): string[] {
  const out: string[] = [];
  for (const rawLine of gitignore.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("!")) continue;
    const anchored = line.startsWith("/");
    const cleaned = line.replace(/^\//, "").replace(/\/$/, "");
    if (cleaned === "") continue;
    const prefix = anchored || cleaned.includes("/") ? "" : "**/";
    out.push(`${prefix}${cleaned}`, `${prefix}${cleaned}/**`);
  }
  return out;
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

async function readSurfaceText(
  absPath: string,
  relPath: string,
  maxBytes: number,
): Promise<{ text: string } | { finding: Finding }> {
  const info = await stat(absPath);
  if (info.size > maxBytes) {
    return {
      finding: {
        ruleIds: [],
        surfaceIds: [],
        severity: "warn",
        category: "structure",
        message: `${relPath} is ${Math.round(info.size / 1024)} KB (> ${Math.round(maxBytes / 1024)} KB cap) — skipped; no agent should be fed a file this size. Split it or remove it.`,
        evidence: `file size ${info.size} bytes`,
      },
    };
  }
  const buffer = await readFile(absPath);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return { text };
  } catch {
    return {
      finding: {
        ruleIds: [],
        surfaceIds: [],
        severity: "info",
        category: "structure",
        message: `${relPath} is not valid UTF-8 — skipped. Re-encode it as UTF-8 so tools can read it.`,
        evidence: "invalid UTF-8 byte sequence",
      },
    };
  }
}

export async function discover(options: DiscoverOptions): Promise<DiscoveryResult> {
  const { root, maxFiles, maxSurfaceBytes } = options;
  const findings: Finding[] = [];

  let gitignoreGlobs: string[] = [];
  try {
    gitignoreGlobs = gitignoreToGlobs(readFileSync(path.join(root, ".gitignore"), "utf8"));
  } catch {
    // No .gitignore — nothing to respect.
  }
  const ignore = [...ALWAYS_IGNORED, ...gitignoreGlobs];

  // Full file walk (streamed, capped) for the repo index used by staleness checks.
  const files: string[] = [];
  let truncated = false;
  const stream = fg.stream("**/*", {
    cwd: root,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore,
  });
  for await (const entry of stream) {
    if (files.length >= maxFiles) {
      truncated = true;
      break;
    }
    files.push(toPosix(String(entry)));
  }
  files.sort();
  if (truncated) {
    findings.push({
      ruleIds: [],
      surfaceIds: [],
      severity: "info",
      category: "structure",
      message: `File index truncated at ${maxFiles} files (--max-files) — stale-reference checks may be incomplete.`,
      evidence: `walk stopped after ${maxFiles} entries`,
    });
  }

  const dirSet = new Set<string>(["."]);
  for (const file of files) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) {
      dirSet.add(parts.slice(0, i).join("/"));
    }
  }

  const scriptsByDir = new Map<string, Set<string>>();
  for (const file of files) {
    if (file !== "package.json" && !file.endsWith("/package.json")) continue;
    try {
      const parsed = JSON.parse(await readFile(path.join(root, file), "utf8")) as {
        scripts?: Record<string, string>;
      };
      const dir = file === "package.json" ? "." : file.slice(0, -"/package.json".length);
      scriptsByDir.set(dir, new Set(Object.keys(parsed.scripts ?? {})));
    } catch {
      // Unparseable package.json — script checks just won't apply there.
    }
  }

  const surfacePaths = (
    await fg(SURFACE_PATTERNS, {
      cwd: root,
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      ignore,
    })
  )
    .map(toPosix)
    .sort();

  const surfaces: Surface[] = [];
  for (const relPath of surfacePaths) {
    const result = await readSurfaceText(path.join(root, relPath), relPath, maxSurfaceBytes);
    if ("finding" in result) {
      findings.push(result.finding);
      continue;
    }
    const { kind, tools } = classifySurface(relPath);
    surfaces.push({
      id: surfaceId(relPath),
      path: relPath,
      kind,
      scope: scopeOf(relPath, kind),
      tools,
      raw: result.text,
      tokensEstimated: estimateTokens(result.text),
    });
  }

  // User-global ~/.claude/CLAUDE.md — loaded by Claude Code for every repo,
  // and invisible to teammates.
  if (options.userGlobalDir) {
    const absPath = path.join(options.userGlobalDir, "CLAUDE.md");
    try {
      const result = await readSurfaceText(absPath, "~/.claude/CLAUDE.md", maxSurfaceBytes);
      if ("text" in result) {
        surfaces.push({
          id: surfaceId("~/.claude/CLAUDE.md"),
          path: "~/.claude/CLAUDE.md",
          kind: "claude-md",
          scope: "user-global",
          tools: ["claude-code"],
          raw: result.text,
          tokensEstimated: estimateTokens(result.text),
        });
      }
    } catch {
      // No user-global file.
    }
  }

  return {
    surfaces,
    index: { files, fileSet: new Set(files), dirSet, scriptsByDir, truncated },
    findings,
  };
}
