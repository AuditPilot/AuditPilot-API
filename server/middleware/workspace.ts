import type { NextFunction, Request, Response } from "express";
import { AppError } from "./errorHandler";
import { paramOf } from "../lib/params";
import { Workspace, type WorkspaceDocument } from "../models/Workspace";
import {
  WorkspaceMember,
  roleAtLeast,
  type WorkspaceRole,
} from "../models/WorkspaceMember";

/**
 * Workspace access enforcement.
 *
 * SECURITY DESIGN (same as middleware/ownership.ts): a workspace the caller is
 * NOT a member of answers 404 — workspace ids must not be enumerable by
 * probing authenticated endpoints. Members with a non-active status (invited,
 * suspended) know the workspace exists, so they get 403 instead.
 *
 * Chain: requireAuth → resolveWorkspaceMember → requireRole(...)
 */

/** Service-level twin of resolveWorkspaceMember (for scripts and internal calls). */
export async function assertWorkspaceMembership(
  userId: string,
  workspaceId: string,
  minRole: WorkspaceRole = "viewer",
): Promise<{ workspace: WorkspaceDocument; member: { role: WorkspaceRole; status: string } }> {
  const workspace = await Workspace.findById(workspaceId);
  if (!workspace) {
    throw AppError.notFound("Workspace not found");
  }
  const member = await WorkspaceMember.findOne({
    workspaceId: workspace._id,
    userId,
  });
  if (!member) {
    throw AppError.notFound("Workspace not found");
  }
  if (member.status !== "active") {
    throw AppError.forbidden(`Workspace membership is ${member.status}`);
  }
  if (!roleAtLeast(member.role, minRole)) {
    throw AppError.forbidden(`Requires ${minRole} role`);
  }
  return { workspace, member: { role: member.role, status: member.status } };
}

export async function resolveWorkspaceMember(req: Request, _res: Response, next: NextFunction) {
  try {
    const workspaceId = paramOf(req, "workspaceId");
    const userId = String((req.user as { _id: unknown } | undefined)?._id ?? "");
    if (!userId) {
      throw AppError.unauthorized();
    }
    if (!workspaceId || !/^[a-f0-9]{24}$/i.test(workspaceId)) {
      throw AppError.notFound("Workspace not found");
    }

    const workspace = await Workspace.findById(workspaceId);
    if (!workspace) {
      throw AppError.notFound("Workspace not found");
    }

    const member = await WorkspaceMember.findOne({
      workspaceId: workspace._id,
      userId,
    });
    if (!member) {
      throw AppError.notFound("Workspace not found");
    }
    if (member.status !== "active") {
      throw AppError.forbidden(`Workspace membership is ${member.status}`);
    }

    req.workspace = workspace;
    req.workspaceMember = member;
    next();
  } catch (err) {
    next(err);
  }
}

/** Must run AFTER resolveWorkspaceMember (needs req.workspaceMember). */
export function requireRole(min: WorkspaceRole) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const role = req.workspaceMember?.role;
    if (!role || !roleAtLeast(role, min)) {
      return next(AppError.forbidden(`Requires ${min} role`));
    }
    next();
  };
}
