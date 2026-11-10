import { runTask, untrustedDataBlock } from "../../integrations/ai/gateway";
import type { SourceControlProvider } from "../../integrations/source-control/types";
import { logger } from "../../config/logger";

export interface PullReviewIssue {
  type?: string;
  severity?: string;
  file?: string;
  description?: string;
  fix?: { old_code?: string; new_code?: string };
  [k: string]: unknown;
}

export interface PullReviewInput {
  owner: string;
  repo: string;
  number: number;
  /** Resolved via the provider factory — never a raw per-request token client. */
  provider: SourceControlProvider;
  userId?: string;
  jobId?: string;
}

/** Prompt budget: 100 files (one full page) — the legacy flow silently capped at 30. */
const MAX_PROMPT_FILES = 100;

/**
 * Fetches the PR diff and asks the AI gateway to review it.
 * Consumes the normalized adapter contract: `patch: null` renders as
 * "patch omitted" — never the string "undefined" (provider-abstraction.md §4).
 */
export async function reviewPullRequest(input: PullReviewInput): Promise<PullReviewIssue[]> {
  const { owner, repo, number, provider } = input;

  const files = [];
  for await (const file of provider.listPullRequestFiles(owner, repo, number, { perPage: 100 })) {
    files.push(file);
    if (files.length >= MAX_PROMPT_FILES) break;
  }
  if (files.length === 0) {
    return [];
  }
  const prContext = files
    .map(f => `File: ${f.path}\nDiff:\n${f.patch ?? "patch omitted (file unchanged/too large)"}`)
    .join("\n\n");

  const { data } = await runTask<{ issues?: unknown }>(
    "pr-review",
    {
      system:
        "You are an expert code reviewer. Analyze the pull request diff data and identify any security vulnerabilities, performance issues, or bugs introduced in these changes. For each issue, provide: type, severity, description, and a fix (old_code and new_code) when possible. Output valid JSON ONLY with an 'issues' array.",
      user: `Review this Pull Request (${owner}/${repo} #${number}):\n\n${untrustedDataBlock(`DIFF of ${owner}/${repo}#${number}`, prContext)}\n\nReview the diff data above and respond in the requested JSON format.`,
    },
    { userId: input.userId, jobId: input.jobId },
  );

  const issues = Array.isArray(data?.issues) ? (data.issues as PullReviewIssue[]) : [];
  logger.info({ owner, repo, number, issues: issues.length }, "PR review completed via AI gateway");
  return issues;
}
