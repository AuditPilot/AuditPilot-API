import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../middleware/auth";
import { AppError } from "../../middleware/errorHandler";
import {
  createAuditHistory,
  createDraft,
  deleteDraft,
  listAuditHistory,
  listDrafts,
  updateDraft,
} from "./service";

export const prManagerRouter = Router();

/**
 * PR drafts + audit-history records for the PR Manager page.
 * Every handler assigns userId from the authenticated session — the client
 * can never read or mutate another user's drafts/history.
 */

function userIdOf(req: Request): string {
  return String((req as { user?: { _id: unknown } }).user?._id);
}

function writeErr(res: Response, error: unknown): Response {
  if (error instanceof AppError) {
    return res.status(error.status).json({ message: error.message });
  }
  return res.status(400).json({ message: (error as Error).message });
}

// === Drafts ===

prManagerRouter.get("/pr-manager/drafts", requireAuth, async (req, res) => {
  try {
    return res.json(await listDrafts(userIdOf(req)));
  } catch (error) {
    return writeErr(res, error);
  }
});

prManagerRouter.post("/pr-manager/drafts", requireAuth, async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { userId: _ignored, _id: _ignoredId, ...rest } = body;
    const draft = await createDraft(rest, userIdOf(req));
    return res.status(201).json(draft);
  } catch (error) {
    return writeErr(res, error);
  }
});

prManagerRouter.patch("/pr-manager/drafts/:id", requireAuth, async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { userId: _ignored, _id: _ignoredId, ...rest } = body;
    const draft = await updateDraft(String(req.params.id), userIdOf(req), rest);
    if (!draft) return res.status(404).json({ message: "Draft not found" });
    return res.json(draft);
  } catch (error) {
    return writeErr(res, error);
  }
});

prManagerRouter.delete("/pr-manager/drafts/:id", requireAuth, async (req, res) => {
  try {
    const ok = await deleteDraft(String(req.params.id), userIdOf(req));
    if (!ok) return res.status(404).json({ message: "Draft not found" });
    return res.status(204).send();
  } catch (error) {
    return writeErr(res, error);
  }
});

// === Audit history ===

prManagerRouter.get("/pr-manager/history", requireAuth, async (req, res) => {
  try {
    const prId = typeof req.query.prId === "string" ? req.query.prId : undefined;
    return res.json(await listAuditHistory(userIdOf(req), prId));
  } catch (error) {
    return writeErr(res, error);
  }
});

prManagerRouter.post("/pr-manager/history", requireAuth, async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { userId: _ignored, _id: _ignoredId, ...rest } = body;
    const entry = await createAuditHistory(rest, userIdOf(req));
    return res.status(201).json(entry);
  } catch (error) {
    return writeErr(res, error);
  }
});
