import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Single source of truth for model identifiers. Nothing else in the codebase
 * may hardcode a model string.
 */
export const MODELS = {
  /** Default judge model for `ctxlint compliance` (current Haiku-class model). */
  judge: "claude-haiku-4-5",
  /** Second model used by `ctxlint compliance --calibrate` for agreement checks. */
  calibration: "claude-sonnet-5",
} as const;

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

/** USD per million tokens; used only for the compliance spend estimate. */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
};

/** Unknown/custom models estimate at Sonnet-tier prices (conservative). */
export const FALLBACK_PRICING: ModelPricing = { inputPerMTok: 3, outputPerMTok: 15 };

export function pricingFor(model: string): ModelPricing {
  return MODEL_PRICING[model] ?? FALLBACK_PRICING;
}

export interface BudgetConfig {
  /** Warn when a single surface exceeds this many estimated tokens. */
  surfaceWarnTokens: number;
  /** Warn when one tool's effective context exceeds this many estimated tokens. */
  effectiveContextWarnTokens: number;
  /** Rules deeper than this fraction of an oversized file are flagged as buried. */
  buriedRuleDepthRatio: number;
}

export interface DiscoveryConfig {
  /** Hard cap on files walked during discovery (`--max-files` overrides). */
  maxFiles: number;
  /** Surfaces larger than this are skipped with a warn finding. */
  maxSurfaceBytes: number;
}

export interface AnalysisConfig {
  /** Pairwise analyzers assert and bail gracefully above this rule count. */
  maxRules: number;
}

export interface ComplianceConfig {
  /** Judge model id. */
  model: string;
  /** Calibration (second-opinion) model id. */
  calibrationModel: string;
  /** Number of recent merged changes to sample. */
  commits: number;
  /** Max concurrent judge requests. */
  concurrency: number;
  /** Require --yes above this estimated spend (USD). */
  spendCapUsd: number;
  /** Fraction of verdicts re-judged during --calibrate. */
  calibrationSampleRatio: number;
  /** Below this agreement, per-rule scores are reported as directional only. */
  agreementWarnThreshold: number;
}

export interface CtxlintConfig {
  budgets: BudgetConfig;
  discovery: DiscoveryConfig;
  analysis: AnalysisConfig;
  compliance: ComplianceConfig;
}

export const DEFAULT_CONFIG: CtxlintConfig = {
  budgets: {
    surfaceWarnTokens: 1500,
    effectiveContextWarnTokens: 4000,
    buriedRuleDepthRatio: 0.7,
  },
  discovery: {
    maxFiles: 20000,
    maxSurfaceBytes: 1024 * 1024,
  },
  analysis: {
    maxRules: 5000,
  },
  compliance: {
    model: MODELS.judge,
    calibrationModel: MODELS.calibration,
    commits: 30,
    concurrency: 4,
    spendCapUsd: 1,
    calibrationSampleRatio: 0.1,
    agreementWarnThreshold: 0.8,
  },
};

export const CONFIG_FILENAME = "ctxlint.config.json";

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly file: string,
  ) {
    super(`${file}: ${message}`);
    this.name = "ConfigError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Shallow-per-section merge of a parsed config file over the defaults.
 * Every value is type-checked against the default it overrides; anything
 * unexpected raises a ConfigError naming the offending key.
 */
function mergeSection<T extends object>(
  defaults: T,
  override: unknown,
  sectionName: string,
  file: string,
): T {
  if (override === undefined) return defaults;
  if (!isPlainObject(override)) {
    throw new ConfigError(`"${sectionName}" must be an object`, file);
  }
  const merged = { ...defaults } as Record<string, unknown>;
  for (const [key, value] of Object.entries(override)) {
    if (!(key in defaults)) {
      throw new ConfigError(`unknown option "${sectionName}.${key}"`, file);
    }
    const expected = typeof merged[key];
    if (typeof value !== expected) {
      throw new ConfigError(
        `"${sectionName}.${key}" must be a ${expected}, got ${typeof value}`,
        file,
      );
    }
    merged[key] = value;
  }
  return merged as T;
}

/**
 * Load ctxlint.config.json from `dir`, merged over DEFAULT_CONFIG.
 * A missing file yields the defaults; a malformed file throws ConfigError.
 */
export async function loadConfig(dir: string): Promise<CtxlintConfig> {
  const file = path.join(dir, CONFIG_FILENAME);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_CONFIG;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`invalid JSON (${(error as Error).message})`, file);
  }
  if (!isPlainObject(parsed)) {
    throw new ConfigError("config must be a JSON object", file);
  }

  const known = new Set(["$schema", "budgets", "discovery", "analysis", "compliance"]);
  for (const key of Object.keys(parsed)) {
    if (!known.has(key)) throw new ConfigError(`unknown section "${key}"`, file);
  }

  return {
    budgets: mergeSection(DEFAULT_CONFIG.budgets, parsed.budgets, "budgets", file),
    discovery: mergeSection(DEFAULT_CONFIG.discovery, parsed.discovery, "discovery", file),
    analysis: mergeSection(DEFAULT_CONFIG.analysis, parsed.analysis, "analysis", file),
    compliance: mergeSection(DEFAULT_CONFIG.compliance, parsed.compliance, "compliance", file),
  };
}
