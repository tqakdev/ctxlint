import type { Code, Heading, List, ListItem, Node, Paragraph, Parent, Root } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { sha1Hex } from "../hash.js";
import type { Rule, RuleKind, Surface } from "../model.js";

const processor = unified().use(remarkParse);

export function parseMarkdown(raw: string): Root {
  return processor.parse(raw) as Root;
}

interface InlineText {
  text: string;
  codeSpans: string[];
}

function isParent(node: Node): node is Parent {
  return Array.isArray((node as Parent).children);
}

/** Pathological nesting guard: content deeper than this is skipped, not walked. */
const MAX_NESTING_DEPTH = 100;

/** Flatten a node to display text, collecting inline-code spans separately. */
export function inlineText(node: Node): InlineText {
  const codeSpans: string[] = [];
  const walk = (n: Node, depth: number): string => {
    if (depth > MAX_NESTING_DEPTH) return "";
    switch (n.type) {
      case "text":
        return (n as unknown as { value: string }).value;
      case "inlineCode": {
        const value = (n as unknown as { value: string }).value;
        codeSpans.push(value);
        return `\`${value}\``;
      }
      case "code":
        return (n as unknown as { value: string }).value;
      case "break":
        return " ";
      case "link": {
        const parent = n as Parent & { url?: string };
        const label = parent.children.map((c) => walk(c, depth + 1)).join("");
        if (parent.url && !/^[a-z]+:/i.test(parent.url) && !parent.url.startsWith("#")) {
          codeSpans.push(parent.url);
        }
        return label;
      }
      default:
        return isParent(n) ? n.children.map((c) => walk(c, depth + 1)).join("") : "";
    }
  };
  const text = walk(node, 0).replace(/\s+/g, " ").trim();
  return { text, codeSpans };
}

// --- Reference extraction ------------------------------------------------

const KNOWN_EXTENSIONS =
  /\.(?:js|jsx|ts|tsx|mjs|cjs|md|mdc|mdx|json|ya?ml|sh|bash|zsh|sql|py|rb|go|rs|java|css|scss|less|html|txt|xml|toml|env|example|sample|snap|svg|png|proto|graphql|tf|ini|cfg|conf)$/i;

/** Conventionally-untracked or generated paths that are noise for staleness. */
const EXCLUDED_FIRST_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "tmp",
  "temp",
  "target",
  "logs",
  ".git",
  ".ctxlint-cache",
]);

/** Metasyntactic path segments ("foo/index.ts", "path/to/file"). */
const PLACEHOLDER_FIRST_SEGMENTS = new Set(["foo", "bar", "baz"]);

/** Placeholder markers inside a filename ("test_action_EventNameHere.py"). */
const PLACEHOLDER_BASENAME = /NameHere|PLACEHOLDER|placeholder|YourName|XXX/;

const EXCLUDED_FILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);

/** Filename-convention placeholders ("Source files: `kebab-case.ts`"). */
const NAMING_CONVENTION =
  /^(?:kebab-case|camelCase|PascalCase|snake_case|SCREAMING_SNAKE_CASE)(?:\.[\w-]+)*$/;

function isExcludedRef(ref: string): boolean {
  if (/(?:^|\/)\.env(?!\.(?:example|sample))/.test(ref)) return true;
  if (ref.includes("...")) return true; // ellipsis path: "webview-ui/.../X.ts"
  const first = ref.split("/")[0] as string;
  if (EXCLUDED_FIRST_SEGMENTS.has(first)) return true;
  if (PLACEHOLDER_FIRST_SEGMENTS.has(first) || ref.startsWith("path/to/")) return true;
  const base = ref.slice(ref.lastIndexOf("/") + 1);
  if (EXCLUDED_FILES.has(base)) return true;
  if (NAMING_CONVENTION.test(base)) return true;
  if (PLACEHOLDER_BASENAME.test(base)) return true;
  if (!ref.includes("/")) {
    // The whole token is a bare extension ("any `.proto` change").
    if (ref.startsWith(".") && ref.lastIndexOf(".") === 0 && KNOWN_EXTENSIONS.test(ref)) {
      return true;
    }
    // Capitalized "extension" is a code identifier ("Schema.Json"), not a file.
    if (/\.[A-Z][a-zA-Z]*$/.test(ref) && KNOWN_EXTENSIONS.test(ref)) return true;
  }
  return false;
}

function looksLikePath(token: string): boolean {
  if (token.length < 2 || token.length > 200) return false;
  if (/[\s<>{}()|=$…]/.test(token)) return false;
  if (/^https?:/i.test(token) || token.includes("://")) return false;
  if (token.startsWith("/") || token.startsWith("~") || token.startsWith("-")) return false;
  if (token.startsWith("#") || token.startsWith("@")) return false;
  if (/^\d+\/\d+$/.test(token)) return false;
  if (token.includes("/")) return true;
  return KNOWN_EXTENSIONS.test(token);
}

/** npm builtin subcommands that are not run-script aliases. */
const NPM_SCRIPT_ALIASES = new Set(["test", "start", "stop", "restart"]);

function extractScriptRef(codeSpan: string): string | undefined {
  const run = /^(?:npm|pnpm|yarn) run ([\w:.-]+)$/.exec(codeSpan);
  if (run) return `npm run ${run[1]}`;
  const alias = /^npm ([\w:.-]+)$/.exec(codeSpan);
  if (alias && NPM_SCRIPT_ALIASES.has(alias[1] as string)) return `npm run ${alias[1]}`;
  return undefined;
}

const BARE_PATH = /(?:^|[\s,;(])((?:\.\/)?[\w@.-]+\/[\w@./*-]+)/g;

/**
 * Rules that state a path no longer exists must not produce stale-reference
 * findings — the author is warning about the absence.
 */
const NEGATED_EXISTENCE =
  /\b(?:no longer exists?|does not exist|doesn'?t exist|was (?:removed|deleted|moved)|is gone|were removed)\b/i;

const NEGATION_WORD = /\b(?:do not|don'?t|never|avoid)\b/i;
const NEGATED_VERB =
  /\b(?:re)?(?:creat|add|us(?:e|ing)|put|stor|import|commit|introduc|touch|generat)/i;
const CREATION_VERB =
  /\b(?:creat(?:e|es|ing)|writ(?:e|es|ing)|generat(?:e|es|ing)|recreat(?:e|es|ing))\b/i;
const LOCATION_PREP = /\b(?:in|into|under|inside|within|at|to|from)\b/i;
const REMOVAL_NEARBY = /\bremov(?:e[ds]?|ing|al)\b|\bdeleted?\b/i;

/**
 * A reference is not an existence claim when its sentence talks about
 * creating it ("Create module-specific conftest.py files"), prohibits it
 * ("do not create files like X", "never use feat/ prefixes"), removes it
 * ("must manually remove .pr/"), or conditions on it ("when .pr/ exists").
 * "Create the definition in src/tools/" keeps src/tools/ — the preposition
 * marks it as a location, and locations must exist.
 */
function inNonExistenceContext(text: string, start: number, end: number): boolean {
  const boundary = /[.;!?]/;
  let sentenceStart = 0;
  for (let i = start - 1; i >= 0; i--) {
    if (boundary.test(text[i] as string)) {
      sentenceStart = i + 1;
      break;
    }
  }
  const prefix = text.slice(sentenceStart, start);
  const stop = text.slice(end, end + 80).search(boundary);
  const suffix = text.slice(end, stop === -1 ? end + 80 : end + stop);

  const negation = NEGATION_WORD.exec(prefix);
  if (negation && NEGATED_VERB.test(prefix.slice(negation.index))) return true;
  const creation = CREATION_VERB.exec(prefix);
  if (creation && !LOCATION_PREP.test(prefix.slice(creation.index + creation[0].length))) {
    return true;
  }
  if (
    /\b(?:when|if)\b/i.test(prefix) &&
    /^\s*(?:directory\s+|folder\s+|file\s+)?exists?\b/i.test(suffix)
  ) {
    return true;
  }
  if (REMOVAL_NEARBY.test(prefix) || REMOVAL_NEARBY.test(suffix)) return true;
  return false;
}

export function extractReferences(text: string, codeSpans: string[]): string[] {
  if (NEGATED_EXISTENCE.test(text)) return [];
  const refs = new Set<string>();
  for (const span of codeSpans) {
    const script = extractScriptRef(span);
    if (script) {
      refs.add(script);
      continue;
    }
    const trimmed = span.replace(/[.,;:]+$/, "");
    if (!looksLikePath(trimmed) || isExcludedRef(trimmed)) continue;
    const at = text.indexOf(`\`${span}\``);
    if (at !== -1 && inNonExistenceContext(text, at, at + span.length + 2)) continue;
    refs.add(trimmed);
  }
  // Bare tokens outside code spans (e.g. plain-text files like .cursorrules).
  const withoutCode = text.replace(/`[^`]*`/g, (span) => " ".repeat(span.length));
  for (const match of withoutCode.matchAll(BARE_PATH)) {
    const token = (match[1] as string).replace(/[.,;:]+$/, "");
    if (!looksLikePath(token) || isExcludedRef(token)) continue;
    const at = match.index + match[0].indexOf(match[1] as string);
    if (inNonExistenceContext(text, at, at + token.length)) continue;
    refs.add(token);
  }
  return [...refs].sort();
}

// --- Classification -------------------------------------------------------

const IMPERATIVE_START =
  /^(?:use|do|don'?t|never|always|avoid|prefer|keep|run|add|remove|write|return|ensure|make|check|include|wrap|log|validate|treat|open|request|follow|coordinate|batch|watch|paginate|anonymize|store|extract|delete|fix|update|link|declare|co-locate|put|leave|send|split|name|mark|call|read|be)\b/i;

const MODAL =
  /\b(?:must(?: not)?|never|always|do not|don'?t|should(?: not)?|required|banned|only|forbidden)\b/i;

export function classifyRule(text: string, referencedPaths: string[]): RuleKind {
  if (MODAL.test(text) || IMPERATIVE_START.test(text)) return "imperative";
  if (referencedPaths.length > 0) return "structure-claim";
  if (text.length > 30) return "context";
  return "unknown";
}

// --- Rule extraction -------------------------------------------------------

const COMMAND_LANGS = new Set(["bash", "sh", "shell", "zsh", "console"]);

function spanOf(node: Node): { startLine: number; endLine: number } {
  return {
    startLine: node.position?.start.line ?? 1,
    endLine: node.position?.end.line ?? node.position?.start.line ?? 1,
  };
}

/**
 * Split a markdown document into atomic rules: list items and paragraphs under
 * headings, plus fenced shell blocks (kind "command"). Shingle-based analyzers
 * downstream are language-agnostic; only classification is English-tuned.
 */
export function extractRules(surface: Surface, root?: Root): Rule[] {
  const tree = root ?? parseMarkdown(surface.raw);
  const rules: Rule[] = [];
  const headings: string[] = [];
  // Duplicate text in one surface gets an occurrence suffix (hash, hash.2, …)
  // so ids stay unique while the first occurrence keeps the bare hash.
  const seen = new Map<string, number>();

  const push = (text: string, codeSpans: string[], node: Node, kind?: RuleKind) => {
    if (text.trim() === "") return;
    const referencedPaths = extractReferences(text, codeSpans);
    const hash = sha1Hex(text);
    const occurrence = (seen.get(hash) ?? 0) + 1;
    seen.set(hash, occurrence);
    rules.push({
      id: `${surface.id}:${hash}${occurrence > 1 ? `.${occurrence}` : ""}`,
      surfaceId: surface.id,
      text,
      section: [...headings],
      span: spanOf(node),
      kind: kind ?? classifyRule(text, referencedPaths),
      referencedPaths,
    });
  };

  const visitBlock = (node: Node, depth: number): void => {
    switch (node.type) {
      case "heading": {
        const heading = node as Heading;
        headings.length = heading.depth - 1;
        // Fill holes left by skipped levels (h1 -> h3) so section paths never
        // contain undefined — common in human-written docs.
        for (let i = 0; i < headings.length; i++) headings[i] ??= "";
        headings[heading.depth - 1] = inlineText(heading).text;
        break;
      }
      case "list":
        for (const item of (node as List).children) {
          const { text, codeSpans } = inlineText(item as ListItem);
          push(text, codeSpans, item);
        }
        break;
      case "paragraph": {
        const { text, codeSpans } = inlineText(node as Paragraph);
        push(text, codeSpans, node);
        break;
      }
      case "code": {
        const code = node as Code;
        if (code.lang && COMMAND_LANGS.has(code.lang)) {
          push(code.value.trim(), [], node, "command");
        }
        break;
      }
      case "blockquote":
        if (depth < MAX_NESTING_DEPTH) {
          for (const child of (node as Parent).children) visitBlock(child, depth + 1);
        }
        break;
      default:
        break;
    }
  };

  for (const child of tree.children) visitBlock(child, 0);
  return rules;
}
