import type { Code, Heading, List, ListItem, Node, Paragraph, Parent, Root } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";
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

/** Flatten a node to display text, collecting inline-code spans separately. */
export function inlineText(node: Node): InlineText {
  const codeSpans: string[] = [];
  const walk = (n: Node): string => {
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
        const label = parent.children.map(walk).join("");
        if (parent.url && !/^[a-z]+:/i.test(parent.url) && !parent.url.startsWith("#")) {
          codeSpans.push(parent.url);
        }
        return label;
      }
      default:
        return isParent(n) ? n.children.map(walk).join("") : "";
    }
  };
  const text = walk(node).replace(/\s+/g, " ").trim();
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
  ".git",
  ".ctxlint-cache",
]);

const EXCLUDED_FILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);

function isExcludedRef(ref: string): boolean {
  if (/^\.env(?!\.(?:example|sample))/.test(ref)) return true;
  const first = ref.split("/")[0] as string;
  if (EXCLUDED_FIRST_SEGMENTS.has(first)) return true;
  if (EXCLUDED_FILES.has(ref.slice(ref.lastIndexOf("/") + 1))) return true;
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
    if (looksLikePath(trimmed) && !isExcludedRef(trimmed)) refs.add(trimmed);
  }
  // Bare tokens outside code spans (e.g. plain-text files like .cursorrules).
  const withoutCode = text.replace(/`[^`]*`/g, " ");
  for (const match of withoutCode.matchAll(BARE_PATH)) {
    const token = (match[1] as string).replace(/[.,;:]+$/, "");
    if (looksLikePath(token) && !isExcludedRef(token)) refs.add(token);
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
  let ordinal = 0;

  const push = (text: string, codeSpans: string[], node: Node, kind?: RuleKind) => {
    if (text.trim() === "") return;
    const referencedPaths = extractReferences(text, codeSpans);
    rules.push({
      id: `${surface.id}:${ordinal}`,
      surfaceId: surface.id,
      text,
      section: [...headings],
      span: spanOf(node),
      kind: kind ?? classifyRule(text, referencedPaths),
      referencedPaths,
    });
    ordinal += 1;
  };

  const visitBlock = (node: Node): void => {
    switch (node.type) {
      case "heading": {
        const heading = node as Heading;
        headings.length = heading.depth - 1;
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
        for (const child of (node as Parent).children) visitBlock(child);
        break;
      default:
        break;
    }
  };

  for (const child of tree.children) visitBlock(child);
  return rules;
}
