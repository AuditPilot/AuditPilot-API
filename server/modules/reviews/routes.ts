import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth";
import { AppError } from "../../middleware/errorHandler";
import { recordAuditLog } from "../../middleware/auditLog";
import { logger } from "../../config/logger";
import { reserve, release, limitReachedError } from "../usage/service";
import { reviewPullRequest } from "./service";
import { providerForUser } from "../workspaces/provider-resolution";
import { PullRequest } from "../../models/PullRequest";
import { Workspace } from "../../models/Workspace";
import { paramOf } from "../../lib/params";

/**
 * Legacy user-scoped review routes, rewired onto the provider factory (M2).
 * PR listing reads the personal-workspace mirror (all authors, deduped across
 * repositories) — the author-restricted `search/issues` query is deleted.
 * The M2 frontend switches to the workspace-scoped endpoints on the same
 * service; these paths remain through the transition.
 */

export const reviewsRouter = Router();

const numberParam = (req: Request) => paramOf(req, "number");

function parseQuery<S extends z.ZodTypeAny>(schema: S, query: unknown): z.output<S> {
  const result = schema.safeParse(query);
  if (!result.success) throw AppError.badRequest("Invalid query", result.error.flatten());
  return result.data;
}

const inboxQuery = z.object({
  state: z.enum(["open", "closed", "merged", "all"]).default("open"),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
});

function errStatus(error: unknown): { status: number; message: string } {
  if (error instanceof AppError) return { status: error.status, message: error.message };
  return { status: 500, message: (error as Error).message };
}

// === Pull request inbox (personal workspace mirror — all authors) ===

reviewsRouter.get("/pulls", requireAuth, async (req: Request, res: Response) => {
  try {
    const query = parseQuery(inboxQuery, req.query);
    const personal = await Workspace.findOne({ owner: req.user!._id, type: "personal" });
    if (!personal) return res.json({ pulls: [], page: 1, hasNext: false });

    const filter: Record<string, unknown> = { workspaceId: personal._id };
    if (query.state !== "all") filter.state = query.state;
    const rows = (await PullRequest.find(filter)
      .sort({ lastSeenAt: -1 })
      .skip((query.page - 1) * query.perPage)
      .limit(query.perPage + 1)
      .populate("repositoryId", "ownerLabels name")
      .lean()) as unknown as Array<{
      _id: unknown;
      number: number;
      title: string;
      state: "open" | "closed" | "merged";
      isDraft: boolean;
      author: { login: string; avatarUrl?: string | null };
      sourceBranch: string;
      destinationBranch: string;
      url: string;
      headSha?: string | null;
      lastSeenAt?: Date;
      repositoryId?: { ownerLabels?: { fullName?: string }; name?: string } | null;
    }>;
    const hasNext = rows.length > query.perPage;
    return res.json({
      pulls: rows.slice(0, query.perPage).map(pr => ({
        id: String(pr._id),
        number: pr.number,
        title: pr.title,
        state: pr.state,
        isDraft: pr.isDraft,
        author: pr.author,
        sourceBranch: pr.sourceBranch,
        destinationBranch: pr.destinationBranch,
        url: pr.url,
        headSha: pr.headSha ?? null,
        lastSeenAt: pr.lastSeenAt ?? null,
        repository: {
          fullName: pr.repositoryId?.ownerLabels?.fullName ?? "",
          name: pr.repositoryId?.name ?? "",
        },
      })),
      page: query.page,
      hasNext,
    });
  } catch (error) {
    const { status, message } = errStatus(error);
    logger.error({ err: message }, "fetch pulls error");
    return res.status(status).json({ message });
  }
});

// === PR files ===

reviewsRouter.get(
  "/repos/:owner/:repo/pulls/:number/files",
  requireAuth,
  async (req: Request, res: Response) => {
    const owner = String(req.params.owner);
    const repo = String(req.params.repo);
    try {
      const provider = await providerForUser(String(req.user!._id));
      const files = [];
      for await (const file of provider.listPullRequestFiles(owner, repo, Number(numberParam(req)), { perPage: 100 })) {
        files.push(file);
        if (files.length >= 300) break; // hard cap for the endpoint surface
      }
      return res.json(files);
    } catch (error) {
      const { status, message } = errStatus(error);
      return res.status(status).json({ message });
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
    const number = Number(numberParam(req));
    const user = req.user!;

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
      const provider = await providerForUser(String(user._id));
      const issues = await reviewPullRequest({ owner, repo, number, provider, userId: String(user._id) });
      return res.json({ issues });
    } catch (error) {
      await release(user._id, "pr-review");
      const { status, message } = errStatus(error);
      if (status >= 500) logger.error({ err: message, owner, repo, number }, "PR audit error");
      return res.status(status).json({ message });
    }
  },
);

// === Fix PR head branch ===

reviewsRouter.post(
  "/repos/:owner/:repo/pulls/:number/fix",
  requireAuth,
  async (req: Request, res: Response) => {
    const owner = String(req.params.owner);
    const repo = String(req.params.repo);
    const number = Number(numberParam(req));
    const { issues } = (req.body ?? {}) as { issues?: unknown[] };

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
      const provider = await providerForUser(String(req.user!._id));
      const pr = await provider.fetchPullRequest(owner, repo, number);
      const headBranch = pr.sourceBranch;
      if (!headBranch) throw AppError.badRequest("pull request has no head branch");

      for (const issue of (issues as FixIssue[]).filter(i => i?.fix)) {
        try {
          const filePath = issue.file || issue.file_path;
          if (!filePath) continue;
          const currentContent = await provider.fetchFileContent(owner, repo, filePath, headBranch);
          if (currentContent === null) continue;
          const newContent = currentContent.replace(issue.fix!.old_code, issue.fix!.new_code);
          if (currentContent !== newContent) {
            await provider.createCommit(owner, repo, {
              branch: headBranch,
              files: [{ path: filePath, content: newContent }],
              message: `AuditPilot: Correcting PR #${number} - ${issue.description || "fix"}`,
            });
          }
        } catch (err) {
          logger.warn({ file: issue.file, err: (err as Error).message }, "skipped fix application for PR file");
        }
      }

      return res.json({ message: "PR corrected successfully" });
    } catch (error) {
      const { status, message } = errStatus(error);
      if (status >= 500) logger.error({ err: message }, "PR fix error");
      return res.status(status).json({ message });
    }
  },
);

// === Merge PR ===

reviewsRouter.put(
  "/repos/:owner/:repo/pulls/:number/merge",
  requireAuth,
  async (req: Request, res: Response) => {
    const owner = String(req.params.owner);
    const repo = String(req.params.repo);
    const number = Number(numberParam(req));

    // NOTE: merging a PR is NOT a review action — it consumes no quota.
    try {
      const provider = await providerForUser(String(req.user!._id));
      await provider.mergePullRequest(owner, repo, number, { method: "squash" });

      recordAuditLog(req, {
        action: "pr.merged",
        targetType: "pr",
        targetId: `${owner}/${repo}#${number}`,
      });

      return res.json({ message: "PR merged and branch cleaned up successfully" });
    } catch (error) {
      const { status, message } = errStatus(error);
      logger.error({ err: message }, "merge error");
      return res.status(status).json({ message });
    }
  },
);

// === PR detail ===

reviewsRouter.get(
  "/repos/:owner/:repo/pulls/:number",
  requireAuth,
  async (req: Request, res: Response) => {
    const owner = String(req.params.owner);
    const repo = String(req.params.repo);
    try {
      const provider = await providerForUser(String(req.user!._id));
      const pr = await provider.fetchPullRequest(owner, repo, Number(numberParam(req)));
      return res.json(pr);
    } catch (error) {
      const { status, message } = errStatus(error);
      logger.error({ err: message, owner, repo, number: numberParam(req) }, "PR detail fetch error");
      return res.status(status).json({ message });
    }
  },
);

// === Update PR metadata ===

reviewsRouter.patch(
  "/repos/:owner/:repo/pulls/:number",
  requireAuth,
  async (req: Request, res: Response) => {
    const owner = String(req.params.owner);
    const repo = String(req.params.repo);
    const number = Number(numberParam(req));
    const body = (req.body ?? {}) as {
      base?: string;
      title?: string;
      body?: string;
      state?: "open" | "closed";
    };

    try {
      const provider = await providerForUser(String(req.user!._id));
      const pr = await provider.updatePullRequest(owner, repo, number, body);
      return res.json(pr);
    } catch (error) {
      const { status, message } = errStatus(error);
      return res.status(status).json({ message });
    }
  },
);
