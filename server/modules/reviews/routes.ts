import { Router, type Request, Response } from "express";
import { requireAuth } from "../../middleware/auth";
import { githubClientFromToken, GitHubApiError } from "../../integrations/github/client";
import { AppError } from "../../middleware/errorHandler";
import { recordAuditLog } from "../../middleware/auditLog";
import { logger } from "../../config/logger";
import { reserve, release, limitReachedError } from "../usage/service";
import { reviewPullRequest } from "./service";

export const reviewsRouter = Router();

function tokenOf(req: Request): string | undefined {
  return (req as { githubAccessToken?: string }).githubAccessToken;
}

// === My pull requests (search: authored by me, open) ===

interface GitHubSearchIssue {
  id: number;
  number: number;
  title: string;
  state: string;
  repository_url: string;
  user: { login: string; avatar_url: string };
  created_at: string;
  updated_at: string;
  html_url: string;
}

interface GitHubTokenUser {
  login: string;
  avatar_url: string;
}

reviewsRouter.get("/pulls", requireAuth, async (req: Request, res: Response) => {
  const gh = githubClientFromToken(tokenOf(req));

  try {
    const userData = await gh.get<GitHubTokenUser>("/user");
    const userLogin = userData.login;

    const searchData = await gh.get<{ items: GitHubSearchIssue[] }>(
      `/search/issues?q=is:open+is:pr+author:${encodeURIComponent(userLogin)}`,
    );

    const pulls = (searchData.items || []).map(item => {
      const repoFull = item.repository_url.replace("https://api.github.com/repos/", "");
      const [owner, name] = repoFull.split("/");
      return {
        id: item.id, // preserves original response contract
        number: item.number,
        title: item.title,
        state: item.state,
        repo: { owner, name, full_name: repoFull },
        user: { login: item.user.login, avatar_url: item.user.avatar_url },
        created_at: item.created_at,
        updated_at: item.updated_at,
        html_url: item.html_url,
      };
    });

    return res.json(pulls);
  } catch (error) {
    const message = error instanceof GitHubApiError ? error.message : "Failed to fetch Pull Requests";
    logger.error({ err: (error as Error).message }, "fetch pulls error");
    return res.status(500).json({ message });
  }
});

// === PR files ===

reviewsRouter.get(
  "/repos/:owner/:repo/pulls/:number/files",
  requireAuth,
  async (req: Request, res: Response) => {
    const { owner, repo, number } = req.params;
    const gh = githubClientFromToken(tokenOf(req));
    try {
      const files = await gh.get(`/repos/${owner}/${repo}/pulls/${number}/files`);
      return res.json(files);
    } catch (error) {
      const message = error instanceof GitHubApiError ? error.message : "Failed to fetch PR files";
      return res.status(500).json({ message });
    }
  },
);

// === AI PR review ===

reviewsRouter.post(
  "/repos/:owner/:repo/pulls/:number/audit",
  requireAuth,
  async (req: Request, res: Response) => {
    const owner = String(req.params.owner);
    const repo = String(req.params.repo);
    const number = String(req.params.number);
    const user = req.user!;
    const gh = githubClientFromToken(tokenOf(req));

    // Usage reservation — atomic gate, ALL plans count PR reviews now
    // (removes the legacy starter-only counting quirk). Released if the
    // review fails so an error never consumes the monthly slot.
    const reservation = await reserve(user._id, "pr-review", { plan: user.plan });
    if (!reservation.ok) {
      return res.status(402).json(
        limitReachedError(user.plan, "pr-review", reservation.used ?? reservation.limit),
      );
    }

    try {
      // AI gateway review (retries, schema gate, cost tracking) — extracted
      // to service so the webhook-triggered job worker (C9) reuses it.
      const issues = await reviewPullRequest({ owner, repo, number, gh, userId: String(user._id) });

      return res.json({ issues });
    } catch (error) {
      await release(user._id, "pr-review");
      if (error instanceof AppError) {
        return res.status(error.status).json({ message: error.message });
      }
      logger.error({ err: (error as Error).message, owner, repo, number }, "PR audit error");
      return res.status(500).json({ message: (error as Error).message });
    }
  },
);

// === Fix PR head branch ===

reviewsRouter.post(
  "/repos/:owner/:repo/pulls/:number/fix",
  requireAuth,
  async (req: Request, res: Response) => {
    const { owner, repo, number } = req.params;
    const { issues } = (req.body ?? {}) as { issues?: unknown[] };
    const gh = githubClientFromToken(tokenOf(req));

    interface FixIssue {
      file?: string;
      file_path?: string;
      description?: string;
      fix?: { old_code: string; new_code: string };
    }

    try {
      if (!Array.isArray(issues)) {
        throw AppError.badRequest("issues (array) is required");
      }
      const prData = await gh.get<{ head: { ref: string } }>(`/repos/${owner}/${repo}/pulls/${number}`);
      const headBranch = prData.head.ref;

      for (const issue of (issues as FixIssue[]).filter(i => i?.fix)) {
        try {
          const fileData = await gh.get<{ content: string; sha: string }>(
            `/repos/${owner}/${repo}/contents/${issue.file || issue.file_path}?ref=${headBranch}`,
          );
          const currentContent = Buffer.from(fileData.content, "base64").toString("utf-8");
          const newContent = currentContent.replace(issue.fix!.old_code, issue.fix!.new_code);

          if (currentContent !== newContent) {
            await gh.put(`/repos/${owner}/${repo}/contents/${issue.file || issue.file_path}`, {
              message: `AuditPilot: Correcting PR #${number} - ${issue.description || "fix"}`,
              content: Buffer.from(newContent).toString("base64"),
              sha: fileData.sha,
              branch: headBranch,
            });
          }
        } catch (err) {
          logger.warn({ file: issue.file, err: (err as Error).message }, "skipped fix application for PR file");
        }
      }

      return res.json({ message: "PR corrected successfully" });
    } catch (error) {
      if (error instanceof AppError) {
        return res.status(error.status).json({ message: error.message });
      }
      logger.error({ err: (error as Error).message }, "PR fix error");
      return res.status(500).json({ message: (error as Error).message });
    }
  },
);

// === Merge PR (squash) ===

reviewsRouter.put(
  "/repos/:owner/:repo/pulls/:number/merge",
  requireAuth,
  async (req: Request, res: Response) => {
    const { owner, repo, number } = req.params;
    const gh = githubClientFromToken(tokenOf(req));

    // NOTE: merging a PR is NOT a review action — it consumes no quota.
    // (The legacy limit gate + doc counter that lived here are gone.)

    try {
      let branchName = "";
      try {
        const prData = await gh.get<{ head: { ref: string } }>(`/repos/${owner}/${repo}/pulls/${number}`);
        branchName = prData.head?.ref || "";
      } catch {
        // proceed without branch info (merge can still happen)
      }

      await gh.put(`/repos/${owner}/${repo}/pulls/${number}/merge`, {
        commit_title: `AuditPilot: Merging PR #${number}`,
        merge_method: "squash",
      });

      if (branchName && (branchName.startsWith("audit-") || branchName.startsWith("auditpilot-fix-"))) {
        logger.info({ branchName }, "deleting temporary fix branch");
        await gh.del(`/repos/${owner}/${repo}/git/refs/heads/${branchName}`);
      }

      recordAuditLog(req, {
        action: "pr.merged",
        targetType: "pr",
        targetId: `${owner}/${repo}#${number}`,
      });

      return res.json({ message: "PR merged and branch cleaned up successfully" });
    } catch (error) {
      const message = error instanceof GitHubApiError ? error.message : (error as Error).message;
      logger.error({ err: message }, "merge error");
      return res.status(500).json({ message });
    }
  },
);

// === PR detail (full PR object — includes body, base/head refs & repo) ===

reviewsRouter.get(
  "/repos/:owner/:repo/pulls/:number",
  requireAuth,
  async (req: Request, res: Response) => {
    const { owner, repo, number } = req.params;
    const gh = githubClientFromToken(tokenOf(req));

    try {
      const pr = await gh.get(`/repos/${owner}/${repo}/pulls/${number}`);
      return res.json(pr);
    } catch (error) {
      const message = error instanceof GitHubApiError ? error.message : "Failed to fetch Pull Request";
      logger.error({ err: message, owner, repo, number }, "PR detail fetch error");
      return res.status(500).json({ message });
    }
  },
);

// === Update PR metadata ===

reviewsRouter.patch(
  "/repos/:owner/:repo/pulls/:number",
  requireAuth,
  async (req: Request, res: Response) => {
    const { owner, repo, number } = req.params;
    const { base, title, body, state } = (req.body ?? {}) as {
      base?: string;
      title?: string;
      body?: string;
      state?: string;
    };
    const gh = githubClientFromToken(tokenOf(req));

    try {
      const updatedPR = await gh.patch(`/repos/${owner}/${repo}/pulls/${number}`, {
        base,
        title,
        body,
        state,
      });
      return res.json(updatedPR);
    } catch (error) {
      const message = error instanceof GitHubApiError ? error.message : "Failed to update Pull Request";
      return res.status(500).json({ message });
    }
  },
);
