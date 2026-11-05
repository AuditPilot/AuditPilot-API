import { Router, type Request, Response } from "express";
import { requireAuth } from "../../middleware/auth";
import { githubClientFromToken, GitHubApiError } from "../../integrations/github/client";
import { logger } from "../../config/logger";

export const reposRouter = Router();

function tokenOf(req: Request): string | undefined {
  return (req as { githubAccessToken?: string }).githubAccessToken;
}

interface GitHubApiRepo {
  id: number;
  name: string;
  full_name: string;
  default_branch: string;
}

reposRouter.get("/repos", requireAuth, async (req: Request, res: Response) => {
  const gh = githubClientFromToken(tokenOf(req));
  try {
    const repos = await gh.get<GitHubApiRepo[]>("/user/repos?sort=updated&per_page=100");
    return res.json(repos);
  } catch (error) {
    logger.error({ err: (error as Error).message }, "failed to fetch repositories from GitHub");
    return res.status(500).json({ message: "Failed to fetch repositories" });
  }
});

reposRouter.get("/repos/:owner/:repo/branches", requireAuth, async (req: Request, res: Response) => {
  const { owner, repo } = req.params;
  const gh = githubClientFromToken(tokenOf(req));
  try {
    const branches = await gh.get<{ name: string }[]>(`/repos/${owner}/${repo}/branches?per_page=100`);
    return res.json(branches.map(b => b.name));
  } catch (error) {
    const message = error instanceof GitHubApiError ? error.message : "Failed to fetch branches";
    logger.warn({ owner, repo, err: (error as Error).message }, "failed to list branches");
    return res.status(500).json({ message });
  }
});
