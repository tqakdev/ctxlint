import { getEncoding, type Tiktoken } from "js-tiktoken";

/**
 * Token counting behind one interface.
 *
 * - `estimateTokens` uses js-tiktoken with o200k_base and is always available
 *   offline. It is an ESTIMATE — tokenizers differ per vendor, and every
 *   user-facing number derived from it must be labeled "≈ estimated tokens".
 * - `createExactCounter` wraps an Anthropic client's countTokens endpoint for
 *   exact Anthropic counts (only used when ANTHROPIC_API_KEY is set).
 */

let encoder: Tiktoken | undefined;

export function estimateTokens(text: string): number {
  encoder ??= getEncoding("o200k_base");
  return encoder.encode(text).length;
}

export const ESTIMATE_LABEL = "≈ estimated tokens (o200k_base) — vendor tokenizers differ";

/** Minimal slice of the Anthropic client we depend on, so tests can inject fakes. */
export interface CountTokensClient {
  messages: {
    countTokens(params: {
      model: string;
      messages: { role: "user"; content: string }[];
    }): Promise<{ input_tokens: number }>;
  };
}

export type ExactCounter = (text: string) => Promise<number>;

export function createExactCounter(client: CountTokensClient, model: string): ExactCounter {
  return async (text: string) => {
    const result = await client.messages.countTokens({
      model,
      messages: [{ role: "user", content: text }],
    });
    return result.input_tokens;
  };
}
