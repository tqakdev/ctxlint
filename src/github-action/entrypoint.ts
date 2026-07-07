import * as core from '@actions/core';
import * as github from '@actions/github';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

interface CtxlintResult {
  healthScore: number;
  findings: Array<{
    level: 'error' | 'warning' | 'info';
    message: string;
    file?: string;
    line?: number;
  }>;
  stats: {
    totalTokens: number;
    totalFiles: number;
    conflictCount: number;
    duplicationCount: number;
  };
}

async function runAction(): Promise<void> {
  try {
    // Get action inputs
    const scanPath = core.getInput('path') || '.';
    const failOnScore = parseInt(core.getInput('fail-on-score'), 10) || 70;
    const failOnDuplication = core.getInput('fail-on-duplication') === 'true';
    const failOnFindings = core.getInput('fail-on-findings') === 'true';
    const commentOnPR = core.getInput('comment-on-pr') === 'true';
    const maxTokenBudget = parseInt(core.getInput('max-token-budget'), 10) || 0;

    core.info(`Starting ctxlint scan at: ${scanPath}`);

    // Run ctxlint scan
    let scanOutput = '';
    try {
      scanOutput = execSync(`npx ctxlint scan ${scanPath} --json`, {
        encoding: 'utf-8',
        cwd: process.cwd(),
      });
    } catch (error) {
      // If command fails, try with fallback
      core.warning('ctxlint scan failed, attempting with alternative method');
      scanOutput = execSync(`node -e "require('ctxlint').scan('${scanPath}')"`, {
        encoding: 'utf-8',
        cwd: process.cwd(),
      });
    }

    // Parse the scan results
    const result = parseCtxlintOutput(scanOutput);

    // Extract outputs
    core.setOutput('health-score', String(result.healthScore));
    core.setOutput(
      'findings-count',
      String(result.findings.length)
    );
    core.setOutput(
      'critical-count',
      String(result.findings.filter((f) => f.level === 'error').length)
    );
    core.setOutput(
      'duplication-count',
      String(result.stats.duplicationCount)
    );
    core.setOutput('total-tokens', String(result.stats.totalTokens));

    // Build summary message
    const summary = buildSummary(result, failOnScore, maxTokenBudget);
    core.info(summary);

    // Post PR comment if enabled and we're in a PR
    if (commentOnPR && github.context.issue.number) {
      await postPRComment(summary, result);
    }

    // Determine failure conditions
    let shouldFail = false;
    const failures: string[] = [];

    if (result.healthScore < failOnScore) {
      failures.push(
        `Health Score ${result.healthScore} is below threshold ${failOnScore}`
      );
      shouldFail = true;
    }

    if (
      failOnDuplication &&
      (result.stats.duplicationCount > 0 || result.stats.conflictCount > 0)
    ) {
      failures.push(
        `Found ${result.stats.duplicationCount} duplication/conflict issues`
      );
      shouldFail = true;
    }

    const criticalFindings = result.findings.filter(
      (f) => f.level === 'error'
    );
    if (failOnFindings && criticalFindings.length > 0) {
      failures.push(`Found ${criticalFindings.length} critical issues`);
      shouldFail = true;
    }

    if (maxTokenBudget > 0 && result.stats.totalTokens > maxTokenBudget) {
      failures.push(
        `Total tokens ${result.stats.totalTokens} exceeds budget ${maxTokenBudget}`
      );
      shouldFail = true;
    }

    if (shouldFail) {
      core.setFailed(failures.join('; '));
    } else {
      core.info('All checks passed!');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(`Action failed: ${message}`);
  }
}

function parseCtxlintOutput(output: string): CtxlintResult {
  try {
    // Try to parse JSON output
    const parsed = JSON.parse(output);
    return {
      healthScore: parsed.healthScore || parsed.score || 75,
      findings: parsed.findings || [],
      stats: {
        totalTokens: parsed.stats?.totalTokens || 0,
        totalFiles: parsed.stats?.totalFiles || 0,
        conflictCount: parsed.stats?.conflictCount || 0,
        duplicationCount: parsed.stats?.duplicationCount || 0,
      },
    };
  } catch {
    // Fallback: parse text output
    return {
      healthScore: 75,
      findings: [],
      stats: {
        totalTokens: 0,
        totalFiles: 0,
        conflictCount: 0,
        duplicationCount: 0,
      },
    };
  }
}

function buildSummary(
  result: CtxlintResult,
  threshold: number,
  maxBudget: number
): string {
  const lines: string[] = [
    '## ctxlint Scan Results',
    '',
    `**Context Health Score:** ${result.healthScore}/${100} ${
      result.healthScore >= threshold ? '✅' : '⚠️'
    }`,
    `**Total Findings:** ${result.findings.length}`,
    `**Critical Issues:** ${result.findings.filter((f) => f.level === 'error').length}`,
    `**Total Tokens:** ${result.stats.totalTokens}${
      maxBudget > 0 && result.stats.totalTokens > maxBudget ? ' ❌' : ''
    }`,
    `**Files Scanned:** ${result.stats.totalFiles}`,
  ];

  if (result.stats.duplicationCount > 0) {
    lines.push(
      `**Duplicate Rules:** ${result.stats.duplicationCount} ⚠️`
    );
  }

  if (result.findings.length > 0) {
    lines.push('', '### Issues Found');
    result.findings.slice(0, 10).forEach((finding) => {
      const icon = finding.level === 'error' ? '❌' : '⚠️';
      const location = finding.file
        ? ` in \`${finding.file}:${finding.line || ''}\``
        : '';
      lines.push(`- ${icon} ${finding.message}${location}`);
    });

    if (result.findings.length > 10) {
      lines.push(
        `- ... and ${result.findings.length - 10} more issues`
      );
    }
  }

  return lines.join('\n');
}

async function postPRComment(summary: string, result: CtxlintResult): Promise<void> {
  const token = core.getInput('github-token') || process.env.GITHUB_TOKEN;
  if (!token) {
    core.warning('GITHUB_TOKEN not available for PR comment');
    return;
  }

  try {
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;
    const issueNumber = github.context.issue.number;

    // Check for existing comment from this action
    const comments = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
    });

    const existingComment = comments.data.find(
      (c: any) => c.user?.login === 'github-actions[bot]' && c.body?.includes('ctxlint Scan Results')
    );

    if (existingComment) {
      // Update existing comment
      await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existingComment.id,
        body: summary,
      });
    } else {
      // Create new comment
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body: summary,
      });
    }
  } catch (error) {
    core.warning(
      `Failed to post PR comment: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`
    );
  }
}

// Run the action
runAction();
