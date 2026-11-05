import { Router, type Request, Response } from "express";
import { requireAuth } from "../../middleware/auth";
import { AppError } from "../../middleware/errorHandler";
import { assertOwnership } from "../../middleware/ownership";
import { recordAuditLog } from "../../middleware/auditLog";
import { githubClientFromToken, GitHubApiError } from "../../integrations/github/client";
import { logger } from "../../config/logger";
import { Audit, type AuditDocument } from "../../models/Audit";
import { reserve, release, limitReachedError } from "../usage/service";
import { enqueue } from "../jobs/queue";
import {
  applyEditedContentsAndCreatePR,
  applyFixesAndCreatePR,
  assertItemAccess,
  buildFixPreview,
  createAudit,
  createAuditItem,
  deleteAudit,
  deleteAuditItem,
  findOwnAuditWithItems,
  listAudits,
  updateAudit,
  updateAuditItem,
} from "./service";

export const auditsRouter = Router();

function tokenOf(req: Request): string | undefined {
  return (req as { githubAccessToken?: string }).githubAccessToken;
}

/** Shared error mapping for GitHub/AI/App errors (same messages as before). */
function handleError(error: unknown, res: Response, label: string) {
  if (error instanceof AppError) {
    return res.status(error.status).json({
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
  }
  if (error instanceof GitHubApiError) {
    const message = error.status === 404 ? `GitHub resource not found: ${error.message}` : error.message;
    const status = error.status >= 500 ? 500 : error.status;
    return res.status(status).json({ message });
  }
  logger.error({ err: (error as Error).message }, label);
  return res.status(500).json({ message: (error as Error).message || "Unexpected error" });
}

/** Fetches an audit by id, enforcing ownership (404 for foreign/missing). */
async function ownAuditOr404(id: string, req: Request) {
  const audit = await Audit.findById(id).lean();
  return assertOwnership(audit, req.user!, "Audit") as AuditDocument;
}

// === Repo deep audit (job-based — worker handles the long-running work) ===

auditsRouter.post("/repos/:owner/:repo/audit", requireAuth, async (req: Request, res: Response) => {
  const owner = String(req.params.owner);
  const repo = String(req.params.repo);
  const { branch: requestedBranch } = (req.body ?? {}) as { branch?: string };
  const user = req.user!;

  // Usage reservation (atomic conditional $inc — racing requests can never
  // over-consume the plan's monthly slot). The worker REFUNDS it if the job
  // permanently fails, so failed audits no longer consume quota.
  const reservation = await reserve(user._id, "audit", { plan: user.plan });
  if (!reservation.ok) {
    return res.status(402).json(
      limitReachedError(user.plan, "audit", reservation.used ?? reservation.limit),
    );
  }

  let job;
  try {
    job = await enqueue({
      type: "repo-audit",
      userId: user._id,
      payload: { owner, repo, requestedBranch },
    });
  } catch (err) {
    // Nothing was queued — give the reserved slot back.
    await release(user._id, "audit");
    throw err;
  }

  recordAuditLog(req, {
    action: "repo.audit.queued",
    targetType: "repo",
    targetId: `${owner}/${repo}`,
    meta: { jobId: String(job._id), branch: requestedBranch ?? null },
  });
  logger.info({ jobId: String(job._id), owner, repo, userId: String(user._id) }, "repo audit queued");

  return res.status(202).json({ jobId: String(job._id) });
});

// === Audit CRUD (ownership-filtered) ===

auditsRouter.get("/audits", requireAuth, async (req, res) => {
  const audits = await listAudits({ userId: req.user!._id });
  return res.json(audits);
});

auditsRouter.get("/audits/:id", requireAuth, async (req, res) => {
  const audit = await findOwnAuditWithItems(String(req.params.id), String(req.user!._id));
  if (!audit) return res.status(404).json({ message: "Audit not found" });
  return res.json(audit);
});

// === Fix preview (REAL current code per item, for the review UI) ===

auditsRouter.get("/audits/:id/fix-preview", requireAuth, async (req, res) => {
  try {
    const audit = await findOwnAuditWithItems(String(req.params.id), String(req.user!._id));
    if (!audit) {
      return res.status(404).json({ message: "Audit not found" });
    }

    const owner = String(req.query.owner ?? "");
    const repo = String(req.query.repo ?? "");
    if (!owner || !repo) {
      return res.status(400).json({ message: "owner and repo query params are required" });
    }

    const targetBranch =
      String(req.query.branch ?? "") || (audit as { branch?: string }).branch || "main";

    const preview = await buildFixPreview({
      owner,
      repo,
      auditId: String(audit._id),
      targetBranch,
      items: (audit.items ?? []) as unknown as Array<Record<string, unknown>>,
      gh: githubClientFromToken(tokenOf(req)),
    });
    return res.json(preview);
  } catch (error) {
    return handleError(error, res, "fix preview error");
  }
});

auditsRouter.post("/repos/:owner/:repo/fix-contents", requireAuth, async (req: Request, res: Response) => {
  const owner = String(req.params.owner);
  const repo = String(req.params.repo);
  const { files, targetBranch, title, description } = (req.body ?? {}) as {
    files?: Record<string, string>;
    targetBranch?: string;
    title?: string;
    description?: string;
  };
  const gh = githubClientFromToken(tokenOf(req));

  try {
    if (!files || Object.keys(files).length === 0 || typeof targetBranch !== "string") {
      throw AppError.badRequest("files (path → content map) and targetBranch are required");
    }
    const result = await applyEditedContentsAndCreatePR({
      owner,
      repo,
      targetBranch,
      files,
      title: typeof title === "string" && title.trim() ? title : undefined,
      description: typeof description === "string" && description.trim() ? description : undefined,
      gh,
    });
    recordAuditLog(req, {
      action: "repo.fix.applied",
      targetType: "repo",
      targetId: `${owner}/${repo}`,
      meta: { pr: result.prNumber, files: result.modifiedFiles, mode: "reviewed-contents" },
    });
    return res.json(result);
  } catch (error) {
    return handleError(error, res, "apply edited contents error");
  }
});

auditsRouter.post("/audits", requireAuth, async (req, res) => {
  try {
    // Ownership is SERVER-assigned — never trust a client-provided userId
    const { userId: _ignored, ...safeBody } = req.body ?? {};
    const audit = await createAudit({ ...safeBody, userId: req.user!._id });
    return res.status(201).json(audit);
  } catch (err) {
    return res.status(400).json({ message: (err as Error).message });
  }
});

auditsRouter.patch("/audits/:id", requireAuth, async (req, res) => {
  try {
    await ownAuditOr404(String(req.params.id), req);
    // userId cannot be reassigned via PATCH
    const { userId: _ignored, ...patch } = req.body ?? {};
    const audit = await updateAudit(String(req.params.id), patch);
    return res.json(audit);
  } catch (err) {
    if (err instanceof AppError) {
      return res.status(err.status).json({ message: err.message });
    }
    return res.status(400).json({ message: (err as Error).message });
  }
});

auditsRouter.delete("/audits/:id", requireAuth, async (req, res) => {
  try {
    await ownAuditOr404(String(req.params.id), req);
    await deleteAudit(String(req.params.id));
    recordAuditLog(req, { action: "audit.deleted", targetType: "audit", targetId: String(req.params.id) });
    return res.status(204).send();
  } catch (err) {
    if (err instanceof AppError) {
      return res.status(err.status).json({ message: err.message });
    }
    return res.status(400).json({ message: (err as Error).message });
  }
});

// === Audit items (ownership-filtered) ===

auditsRouter.post("/audits/:auditId/items", requireAuth, async (req, res) => {
  try {
    const parentAudit = await Audit.findById(String(req.params.auditId)).lean();
    assertOwnership(parentAudit, req.user!, "Audit");
    const { userId: _ignored, ...safeBody } = req.body ?? {};
    const item = await createAuditItem({
      ...safeBody,
      auditId: req.params.auditId,
      userId: req.user!._id,
    });
    return res.status(201).json(item);
  } catch (err) {
    if (err instanceof AppError) {
      return res.status(err.status).json({ message: err.message });
    }
    return res.status(400).json({ message: (err as Error).message });
  }
});

auditsRouter.patch("/audit-items/:id", requireAuth, async (req, res) => {
  try {
    await assertItemAccess(String(req.params.id), String(req.user!._id));
    const { userId: _ignored, ...patch } = req.body ?? {};
    const item = await updateAuditItem(String(req.params.id), patch);
    if (!item) return res.status(404).json({ message: "Item not found" });
    return res.json(item);
  } catch (err) {
    if (err instanceof AppError) {
      return res.status(err.status).json({ message: err.message });
    }
    return res.status(400).json({ message: (err as Error).message });
  }
});

auditsRouter.delete("/audit-items/:id", requireAuth, async (req, res) => {
  try {
    await assertItemAccess(String(req.params.id), String(req.user!._id));
    await deleteAuditItem(String(req.params.id));
    return res.status(204).send();
  } catch (err) {
    if (err instanceof AppError) {
      return res.status(err.status).json({ message: err.message });
    }
    return res.status(400).json({ message: (err as Error).message });
  }
});

// === Fix application (audit → new branch + PR) ===

auditsRouter.post("/repos/:owner/:repo/fix", requireAuth, async (req: Request, res: Response) => {
  const owner = String(req.params.owner);
  const repo = String(req.params.repo);
  const { issues, targetBranch, title, description } = (req.body ?? {}) as {
    issues?: unknown[];
    targetBranch?: string;
    title?: string;
    description?: string;
  };
  const gh = githubClientFromToken(tokenOf(req));

  try {
    if (!Array.isArray(issues) || typeof targetBranch !== "string") {
      throw AppError.badRequest("issues (array) and targetBranch are required");
    }
    const result = await applyFixesAndCreatePR({
      owner,
      repo,
      targetBranch,
      issues: issues as never[],
      title: typeof title === "string" && title.trim() ? title : undefined,
      description: typeof description === "string" && description.trim() ? description : undefined,
      gh,
    });
    recordAuditLog(req, {
      action: "repo.fix.applied",
      targetType: "repo",
      targetId: `${owner}/${repo}`,
      meta: { pr: result.prNumber, files: result.modifiedFiles },
    });
    return res.json(result);
  } catch (error) {
    return handleError(error, res, "apply fix error");
  }
});
