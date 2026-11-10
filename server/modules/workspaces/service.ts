import { randomBytes } from "node:crypto";
import type { Types } from "mongoose";
import {
  Workspace,
  type WorkspaceDocument,
  type WorkspaceType,
} from "../../models/Workspace";
import {
  WorkspaceMember,
  type WorkspaceMemberDocument,
  type WorkspaceRole,
} from "../../models/WorkspaceMember";
import {
  ProviderConnection,
  type ProviderConnectionDocument,
} from "../../models/ProviderConnection";
import {
  Repository,
  type RepositoryDocument,
} from "../../models/Repository";
import { AppError } from "../../middleware/errorHandler";

/**
 * Workspace service — all functions are workspace-scoped and access-checked by
 * their route callers. Cross-workspace isolation is enforced here AND at the
 * route layer (defense in depth).
 */

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base.length > 0 ? base : "workspace";
}

async function uniqueSlug(desired: string): Promise<string> {
  if (SLUG_RE.test(desired) && !(await Workspace.findOne({ slug: desired }))) {
    return desired;
  }
  // Collision (or invalid base) — append a short random suffix until free
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = `${desired || "workspace"}-${randomBytes(3).toString("hex")}`;
    if (SLUG_RE.test(candidate) && !(await Workspace.findOne({ slug: candidate }))) {
      return candidate;
    }
  }
  throw AppError.conflict("Could not allocate a unique workspace slug");
}

export async function createWorkspace(input: {
  name: string;
  ownerUserId: string;
  type?: WorkspaceType;
  slugHint?: string;
}): Promise<WorkspaceDocument> {
  const slug = await uniqueSlug(input.slugHint ? slugify(input.slugHint) : slugify(input.name));
  const workspace = await Workspace.create({
    name: input.name,
    slug,
    owner: input.ownerUserId,
    type: input.type ?? "personal",
  });
  await WorkspaceMember.create({
    workspaceId: workspace._id,
    userId: input.ownerUserId,
    role: "owner",
    status: "active",
    joinedAt: new Date(),
  });
  return workspace;
}

/**
 * Idempotent personal-workspace provisioning (used at login in a later step
 * and by scripts/migrate-workspaces.ts). Returns the existing workspace if
 * the user already has one.
 */
export async function ensurePersonalWorkspace(user: {
  _id: unknown;
  username: string;
}): Promise<WorkspaceDocument> {
  const userId = String(user._id);
  const existing = await Workspace.findOne({ owner: userId, type: "personal" });
  if (existing) {
    await ensureMembership(existing._id, userId, "owner");
    return existing;
  }
  return createWorkspace({
    name: `${user.username}'s workspace`,
    ownerUserId: userId,
    type: "personal",
    slugHint: user.username,
  });
}

async function ensureMembership(
  workspaceId: Types.ObjectId | string,
  userId: string,
  role: WorkspaceRole,
): Promise<void> {
  await WorkspaceMember.updateOne(
    { workspaceId, userId },
    {
      $setOnInsert: {
        workspaceId,
        userId,
        role,
        status: "active",
        joinedAt: new Date(),
      },
    },
    { upsert: true },
  );
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  type: WorkspaceType;
  plan: string;
  role: WorkspaceRole;
  owner: string;
  createdAt: Date;
}

export async function listWorkspacesForUser(userId: string): Promise<WorkspaceSummary[]> {
  const memberships = await WorkspaceMember.find({ userId, status: "active" });
  if (memberships.length === 0) return [];
  const ids = memberships.map(m => m.workspaceId);
  const workspaces = await Workspace.find({ _id: { $in: ids } }).sort({ createdAt: 1 });
  const roleByWorkspace = new Map(
    memberships.map(m => [String(m.workspaceId), m.role as WorkspaceRole]),
  );
  return workspaces.map(w => ({
    id: String(w._id),
    name: w.name,
    slug: w.slug,
    type: w.type,
    plan: w.plan,
    role: roleByWorkspace.get(String(w._id)) ?? "viewer",
    owner: String(w.owner),
    createdAt: w.createdAt,
  }));
}

export async function getWorkspaceForUser(
  userId: string,
  workspaceId: string,
): Promise<WorkspaceDocument> {
  const workspace = await Workspace.findById(workspaceId);
  if (!workspace) throw AppError.notFound("Workspace not found");
  const member = await WorkspaceMember.findOne({ workspaceId: workspace._id, userId });
  if (!member) throw AppError.notFound("Workspace not found");
  if (member.status !== "active") throw AppError.forbidden(`Workspace membership is ${member.status}`);
  return workspace;
}

export async function renameWorkspace(
  workspaceId: string,
  name: string,
): Promise<WorkspaceDocument> {
  // slug stays stable on rename — it is the external handle
  const workspace = await Workspace.findByIdAndUpdate(
    workspaceId,
    { $set: { name: name.trim() } },
    { new: true, runValidators: true },
  );
  if (!workspace) throw AppError.notFound("Workspace not found");
  return workspace;
}

/** Owner-only; refuses while repositories are registered (data-integrity guard). */
export async function deleteWorkspaceIfEmpty(workspaceId: string): Promise<void> {
  const repoCount = await Repository.countDocuments({
    workspaceId,
    removedAt: null,
  });
  if (repoCount > 0) {
    throw AppError.conflict(
      "Workspace still has registered repositories — disconnect them first",
    );
  }
  await WorkspaceMember.deleteMany({ workspaceId });
  await Workspace.deleteOne({ _id: workspaceId });
}

export async function listMembers(workspaceId: string): Promise<WorkspaceMemberDocument[]> {
  return WorkspaceMember.find({ workspaceId }).sort({ createdAt: 1 });
}

export async function addMember(input: {
  workspaceId: string;
  targetUserId: string;
  role: WorkspaceRole;
}): Promise<WorkspaceMemberDocument> {
  if (input.role === "owner") {
    throw AppError.badRequest("Ownership is transferred, never granted via member creation");
  }
  const existing = await WorkspaceMember.findOne({
    workspaceId: input.workspaceId,
    userId: input.targetUserId,
  });
  if (existing) {
    throw AppError.conflict("User is already a member of this workspace");
  }
  try {
    return await WorkspaceMember.create({
      workspaceId: input.workspaceId,
      userId: input.targetUserId,
      role: input.role,
      status: "active",
      joinedAt: new Date(),
    });
  } catch (err) {
    // Race with a concurrent add — surface as conflict, not 500
    if ((err as { code?: number }).code === 11000) {
      throw AppError.conflict("User is already a member of this workspace");
    }
    throw err;
  }
}

/**
 * Role changes: admins can manage developer/viewer roles; only the owner can
 * change admin roles; the owner's own membership is immutable (transfer is a
 * separate M8 feature).
 */
export async function changeMemberRole(input: {
  workspaceId: string;
  actorUserId: string;
  actorRole: WorkspaceRole;
  targetUserId: string;
  role: WorkspaceRole;
}): Promise<WorkspaceMemberDocument> {
  const target = await WorkspaceMember.findOne({
    workspaceId: input.workspaceId,
    userId: input.targetUserId,
  });
  if (!target) throw AppError.notFound("Member not found");
  if (target.role === "owner" || input.role === "owner") {
    throw AppError.forbidden("Workspace ownership cannot be changed here");
  }
  const promotingToAdmin = input.role === "admin";
  if (promotingToAdmin && input.actorRole !== "owner") {
    throw AppError.forbidden("Only the workspace owner can grant the admin role");
  }
  target.role = input.role;
  await target.save();
  return target;
}

export async function removeMember(input: {
  workspaceId: string;
  targetUserId: string;
}): Promise<void> {
  const target = await WorkspaceMember.findOne({
    workspaceId: input.workspaceId,
    userId: input.targetUserId,
  });
  if (!target) throw AppError.notFound("Member not found");
  if (target.role === "owner") {
    throw AppError.forbidden("The workspace owner cannot be removed");
  }
  await target.deleteOne();
}

// ---------------------------------------------------------------------------
// Provider connections + repository registry
// ---------------------------------------------------------------------------

export type { ProviderConnectionDocument };

export async function listProviderConnections(
  workspaceId: string,
): Promise<Array<Pick<ProviderConnectionDocument, "provider" | "kind" | "providerAccountId" | "providerAccountLogin" | "status" | "createdAt">>> {
  // credentialsEncrypted is select:false — projections here are inherently safe
  const connections = await ProviderConnection.find({ workspaceId }).sort({ createdAt: 1 });
  return connections.map(c => ({
    provider: c.provider,
    kind: c.kind,
    providerAccountId: c.providerAccountId,
    providerAccountLogin: c.providerAccountLogin,
    status: c.status,
    createdAt: c.createdAt,
  }));
}

export interface RegisterRepositoryInput {
  provider: "github" | "bitbucket";
  providerExternalId: string;
  ownerAccount: string;
  fullName: string;
  name?: string;
  description?: string | null;
  visibility?: "public" | "private" | "internal";
  archived?: boolean;
  defaultBranch?: string | null;
}

/**
 * Upsert spine for the repository registry. Idempotent on
 * {workspaceId, provider, providerExternalId}; races resolve to the same row.
 */
export async function registerRepository(input: {
  workspaceId: string;
  providerConnectionId: string;
  repo: RegisterRepositoryInput;
}): Promise<RepositoryDocument> {
  const connection = await ProviderConnection.findOne({
    _id: input.providerConnectionId,
    workspaceId: input.workspaceId,
  });
  if (!connection) {
    throw AppError.notFound("Provider connection not found");
  }

  const filter = {
    workspaceId: input.workspaceId,
    provider: input.repo.provider,
    providerExternalId: input.repo.providerExternalId,
  };
  const update = {
    $set: {
      providerConnectionId: input.providerConnectionId,
      provider: input.repo.provider,
      ownerLabels: {
        account: input.repo.ownerAccount,
        fullName: input.repo.fullName,
      },
      name: input.repo.name ?? input.repo.fullName.split("/").pop() ?? input.repo.fullName,
      description: input.repo.description ?? null,
      visibility: input.repo.visibility ?? "private",
      archived: input.repo.archived ?? false,
      defaultBranch: input.repo.defaultBranch ?? null,
      lastSyncedAt: new Date(),
    },
    $setOnInsert: {
      workspaceId: input.workspaceId,
      syncState: "active" as const,
    },
    $unset: { removedAt: 1, connectionRemovedAt: 1 },
  };

  try {
    return (await Repository.findOneAndUpdate(filter, update, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
      runValidators: true,
    })) as RepositoryDocument;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      // Concurrent registration of the same repo — the row exists, read it
      const existing = await Repository.findOne(filter);
      if (existing) return existing;
    }
    throw err;
  }
}

export async function listRepositories(workspaceId: string): Promise<RepositoryDocument[]> {
  return Repository.find({
    workspaceId,
    removedAt: null,
  }).sort({ "ownerLabels.fullName": 1 });
}
