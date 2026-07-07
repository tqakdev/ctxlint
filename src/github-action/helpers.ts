/**
 * GitHub Action integration for ctxlint
 * Provides utilities for running ctxlint scans and formatting results for GitHub Actions
 */

export interface CtxlintScanResult {
  summary?: {
    healthScore: number;
  };
  findings?: Array<{
    level: 'error' | 'warning' | 'info';
    message: string;
    file?: string;
    line?: number;
  }>;
  stats?: {
    totalTokens: number;
    totalFiles: number;
    duplicationCount: number;
  };
}

export interface ActionConfig {
  scanPath: string;
  failOnScore: number;
  failOnDuplication: boolean;
  failOnFindings: boolean;
  commentOnPR: boolean;
  maxTokenBudget: number;
}

export interface ActionOutput {
  healthScore: number;
  findingsCount: number;
  criticalCount: number;
  duplicationCount: number;
  totalTokens: number;
}

export function formatMarkdownSummary(
  result: CtxlintScanResult,
  threshold: number,
  maxBudget: number
): string {
  const lines: string[] = [
    '## ctxlint Scan Results',
    '',
  ];

  const healthScore = result.summary?.healthScore || 75;
  const scoreStatus = healthScore >= threshold ? '✅' : '⚠️';

  lines.push(
    `**Context Health Score:** ${healthScore}/100 ${scoreStatus}`,
    `**Total Findings:** ${result.findings?.length || 0}`,
    `**Critical Issues:** ${
      result.findings?.filter((f: any) => f.level === 'error').length || 0
    }`,
    `**Total Tokens:** ${result.stats?.totalTokens || 0}${
      maxBudget > 0 && (result.stats?.totalTokens || 0) > maxBudget
        ? ' ❌ Over budget'
        : ''
    }`,
    `**Files Scanned:** ${result.stats?.totalFiles || 0}`,
  );

  const duplicationCount = result.stats?.duplicationCount || 0;
  if (duplicationCount > 0) {
    lines.push(`**Duplicate Rules:** ${duplicationCount} ⚠️`);
  }

  const findingsCount = result.findings?.length || 0;
  if (findingsCount > 0) {
    lines.push('', '### Issues Found');
    const displayFindings = (result.findings || []).slice(0, 10);
    displayFindings.forEach((finding: any) => {
      const icon = finding.level === 'error' ? '❌' : '⚠️';
      const location = finding.file
        ? ` in \`${finding.file}${finding.line ? `:${finding.line}` : ''}\``
        : '';
      lines.push(`- ${icon} ${finding.message}${location}`);
    });

    if (findingsCount > 10) {
      lines.push(`- ... and ${findingsCount - 10} more issues`);
    }
  } else {
    lines.push('', '✅ No issues found!');
  }

  return lines.join('\n');
}

export function extractOutputs(result: CtxlintScanResult): ActionOutput {
  return {
    healthScore: result.summary?.healthScore || 75,
    findingsCount: result.findings?.length || 0,
    criticalCount:
      result.findings?.filter((f: any) => f.level === 'error').length || 0,
    duplicationCount: result.stats?.duplicationCount || 0,
    totalTokens: result.stats?.totalTokens || 0,
  };
}

export function shouldFail(
  outputs: ActionOutput,
  config: ActionConfig
): { shouldFail: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (config.failOnScore && outputs.healthScore < config.failOnScore) {
    reasons.push(
      `Health Score ${outputs.healthScore} is below threshold ${config.failOnScore}`
    );
  }

  if (
    config.failOnDuplication &&
    outputs.duplicationCount > 0
  ) {
    reasons.push(`Found ${outputs.duplicationCount} duplication/conflict issues`);
  }

  if (config.failOnFindings && outputs.criticalCount > 0) {
    reasons.push(`Found ${outputs.criticalCount} critical issues`);
  }

  if (
    config.maxTokenBudget > 0 &&
    outputs.totalTokens > config.maxTokenBudget
  ) {
    reasons.push(
      `Total tokens ${outputs.totalTokens} exceeds budget ${config.maxTokenBudget}`
    );
  }

  return {
    shouldFail: reasons.length > 0,
    reasons,
  };
}
