import { GitHubClient } from "../../integrations/github/client";
import { runTask, untrustedDataBlock } from "../../integrations/ai/gateway";
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
  number: string;
  gh: GitHubClient;
  userId?: string;
  jobId?: string;
}

/**
 * Fetches the PR diff and asks the AI gateway to review it.
 * Extracted from the HTTP route so the (C9) webhook-triggered job worker
 * reuses exactly the same logic.
 */
export async function reviewPullRequest(input: PullReviewInput): Promise<PullReviewIssue[]> {
  const { owner, repo, number, gh } = input;

  interface PRFileDiff {
    filename: string;
    patch?: string;
  }

  const files = await gh.get<PRFileDiff[]>(`/repos/${owner}/${repo}/pulls/${number}/files`);
  if (!Array.isArray(files) || files.length === 0) {
    return [];
  }
  const prContext = files
    .map(f => `File: ${f.filename}\nDiff:\n${f.patch}`)
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
