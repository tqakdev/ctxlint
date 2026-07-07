import { pricingFor } from "../config.js";
import type { Rule } from "../core/model.js";
import { estimateTokens } from "../core/tokens.js";
import { type CachedVerdict, cacheKey, ruleHash, type VerdictCache } from "./cache.js";
import type { DiffChunk } from "./sampler.js";

/**
 * Minimal model-client interface so tests inject fakes and never touch the
 * network. The real implementation wraps @anthropic-ai/sdk.
 */
export interface JudgeClient {
  complete(request: { model: string; prompt: string; maxTokens: number }): Promise<string>;
}

export function anthropicJudgeClient(): JudgeClient {
  return {
    async complete({ model, prompt, maxTokens }) {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic();
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      });
      return response.content
        .filter(
          (block): block is { type: "text"; text: string } & typeof block => block.type === "text",
        )
        .map((block) => block.text)
        .join("");
    },
  };
}

export type Verdict = CachedVerdict["verdict"];

const VERDICTS: ReadonlySet<string> = new Set(["followed", "violated", "not-applicable"]);

export const JUDGE_MAX_OUTPUT_TOKENS = 200;

export function buildJudgePrompt(ruleText: string, chunk: DiffChunk): string {
  return [
    "You are auditing whether a code change follows a project rule from the repo's agent-context files.",
    "",
    `RULE: ${ruleText}`,
    "",
    `DIFF (commit ${chunk.sha.slice(0, 10)}, files: ${chunk.files.join(", ")}):`,
    chunk.diff,
    "",
    'Respond with ONLY strict JSON, no prose: {"verdict":"followed"|"violated"|"not-applicable","evidence":"one short quote from the diff that justifies the verdict"}',
    'Use "not-applicable" when the rule does not bear on this change at all.',
  ].join("\n");
}

/** Parse a strict-JSON verdict; malformed output yields undefined, never a throw. */
export function parseVerdict(raw: string): { verdict: Verdict; evidence: string } | undefined {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const verdict = (parsed as { verdict?: unknown }).verdict;
  if (typeof verdict !== "string" || !VERDICTS.has(verdict)) return undefined;
  const evidence = (parsed as { evidence?: unknown }).evidence;
  return {
    verdict: verdict as Verdict,
    evidence: typeof evidence === "string" ? evidence.slice(0, 300) : "",
  };
}

export interface JudgePair {
  rule: Rule;
  chunk: DiffChunk;
}

export interface JudgedPair extends JudgePair {
  verdict?: Verdict;
  evidence: string;
  fromCache: boolean;
  error?: string;
}

export interface CostEstimate {
  pairs: number;
  cachedPairs: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

/** Up-front spend estimate for the UNCACHED portion of the judgments. */
export function estimateCost(pairs: JudgePair[], cache: VerdictCache, model: string): CostEstimate {
  let inputTokens = 0;
  let uncached = 0;
  for (const pair of pairs) {
    const key = cacheKey(ruleHash(pair.rule.text), pair.chunk.id, model);
    if (cache.get(key)) continue;
    uncached += 1;
    inputTokens += estimateTokens(buildJudgePrompt(pair.rule.text, pair.chunk));
  }
  const outputTokens = uncached * JUDGE_MAX_OUTPUT_TOKENS;
  const pricing = pricingFor(model);
  const usd =
    (inputTokens * pricing.inputPerMTok) / 1_000_000 +
    (outputTokens * pricing.outputPerMTok) / 1_000_000;
  return {
    pairs: pairs.length,
    cachedPairs: pairs.length - uncached,
    inputTokens,
    outputTokens,
    usd,
  };
}

/**
 * Judge pairs with a bounded worker pool; verdicts land in the cache so
 * reruns are incremental. Malformed model output is recorded as an error on
 * the pair, never thrown.
 */
export async function judgePairs(
  pairs: JudgePair[],
  client: JudgeClient,
  model: string,
  cache: VerdictCache,
  concurrency: number,
): Promise<JudgedPair[]> {
  const results = new Array<JudgedPair>(pairs.length);
  let next = 0;

  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= pairs.length) return;
      const pair = pairs[index] as JudgePair;
      const key = cacheKey(ruleHash(pair.rule.text), pair.chunk.id, model);
      const cached = cache.get(key);
      if (cached) {
        results[index] = {
          ...pair,
          verdict: cached.verdict,
          evidence: cached.evidence,
          fromCache: true,
        };
        continue;
      }
      try {
        const raw = await client.complete({
          model,
          prompt: buildJudgePrompt(pair.rule.text, pair.chunk),
          maxTokens: JUDGE_MAX_OUTPUT_TOKENS,
        });
        const parsed = parseVerdict(raw);
        if (!parsed) {
          results[index] = {
            ...pair,
            evidence: "",
            fromCache: false,
            error: `unparseable model output: ${raw.slice(0, 80)}`,
          };
          continue;
        }
        cache.set(key, { ...parsed, model, at: new Date().toISOString() });
        results[index] = { ...pair, ...parsed, fromCache: false };
      } catch (error) {
        results[index] = {
          ...pair,
          evidence: "",
          fromCache: false,
          error: (error as Error).message,
        };
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, pairs.length)) }, worker),
  );
  return results;
}
