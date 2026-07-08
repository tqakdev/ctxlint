import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha1Hex } from "../core/hash.js";

export interface CachedVerdict {
  verdict: "followed" | "violated" | "not-applicable";
  evidence: string;
  model: string;
  at: string;
}

export function ruleHash(ruleText: string): string {
  return sha1Hex(ruleText);
}

export function cacheKey(ruleTextHash: string, chunkHash: string, model: string): string {
  return `${ruleTextHash}|${chunkHash}|${model}`;
}

/**
 * Disk cache keyed by (ruleHash, chunkHash, model) so reruns are incremental:
 * unchanged rules judged against unchanged commits cost nothing.
 */
export class VerdictCache {
  private entries = new Map<string, CachedVerdict>();
  private dirty = false;

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Record<string, CachedVerdict>;
      this.entries = new Map(Object.entries(parsed));
    } catch {
      this.entries = new Map();
    }
  }

  get(key: string): CachedVerdict | undefined {
    return this.entries.get(key);
  }

  set(key: string, verdict: CachedVerdict): void {
    this.entries.set(key, verdict);
    this.dirty = true;
  }

  get size(): number {
    return this.entries.size;
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(Object.fromEntries(this.entries), null, 1), "utf8");
    this.dirty = false;
  }
}
