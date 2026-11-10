import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../middleware/auth";
import { AppError } from "../../middleware/errorHandler";
import { logger } from "../../config/logger";
import { providerForUser } from "../workspaces/provider-resolution";

/**
 * Legacy user-scoped routes, rewired onto the provider factory (M2).
 * Credential sourcing no longer reads request tokens inline; these paths
 * resolve the caller's personal-workspace connection and are superseded by the
 * workspace-scoped endpoints during the M2 frontend switchover.
 */

export const reposRouter = Router();

reposRouter.get("/repos", requireAuth, async (req: Request, res: Response) => {
  try {
    const provider = await providerForUser(String(req.user!._id));
    const repositories = [];
    for await (const repo of provider.listRepositories({ perPage: 100 })) {
      repositories.push(repo);
      if (repositories.length >= 100) break; // first page for the picker; workspace registry owns sync
    }
    return res.json(repositories);
  } catch (error) {
    if (error instanceof AppError) {
      return res.status(error.status).json({ message: error.message });
    }
    logger.error({ err: (error as Error).message }, "failed to fetch repositories from provider");
    return res.status(500).json({ message: "Failed to fetch repositories" });
  }
});

reposRouter.get("/repos/:owner/:repo/branches", requireAuth, async (req: Request, res: Response) => {
  const owner = String(req.params.owner);
  const repo = String(req.params.repo);
  try {
    const provider = await providerForUser(String(req.user!._id));
    const branches = [];
    for await (const branch of provider.listBranches(owner, repo, { perPage: 100 })) {
      branches.push({ name: branch.name, commitSha: branch.commitSha, isDefault: branch.isDefault });
      if (branches.length >= 100) break;
    }
    return res.json(branches);
  } catch (error) {
    if (error instanceof AppError) {
      return res.status(error.status).json({ message: error.message });
    }
    logger.warn({ owner, repo, err: (error as Error).message }, "failed to list branches");
    return res.status(500).json({ message: "Failed to fetch branches" });
  }
});
