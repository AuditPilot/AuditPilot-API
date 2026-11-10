import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth";
import { AppError } from "../../middleware/errorHandler";
import { resolveWorkspaceMember, requireRole } from "../../middleware/workspace";
import { ProviderConnection } from "../../models/ProviderConnection";
import { Repository, type RepositoryDocument } from "../../models/Repository";
import { PullRequest, type PullRequestState } from "../../models/PullRequest";
import { paramOf } from "../../lib/params";
import { type WorkspaceRole } from "../../models/WorkspaceMember";
import { providerForWorkspace } from "./provider-resolution";
import { syncRepositoryRecord, syncRepositoryPullRequests } from "./sync";

/** Express 5 params can be string|string[] — normalize to a plain string. */
const wsId = (req: Request) => paramOf(req, "workspaceId");
const memberId = (req: Request) => paramOf(req, "userId");
import {
  addMember,
  changeMemberRole,
  createWorkspace,
  deleteWorkspaceIfEmpty,
  getWorkspaceForUser,
  listMembers,
  listProviderConnections,
  listRepositories,
  listWorkspacesForUser,
  registerRepository,
  removeMember,
  renameWorkspace,
} from "./service";

export const workspacesRouter = Router();

/** Route-body validation (zod) — the pattern new modules follow. */
function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw AppError.badRequest("Invalid request body", result.error.flatten());
  }
  return result.data;
}

function memberJson(m: {
  _id: unknown;
  userId: unknown;
  role: WorkspaceRole;
  status: string;
  joinedAt?: Date | null;
}) {
  return {
    id: String(m._id),
    userId: String(m.userId),
    role: m.role,
    status: m.status,
    joinedAt: m.joinedAt ?? null,
  };
}

const idSchema = z.string().regex(/^[a-f0-9]{24}$/i, "Invalid id");

// ---------------------------------------------------------------------------
// Workspace CRUD
// ---------------------------------------------------------------------------

workspacesRouter.get("/workspaces", requireAuth, async (req: Request, res: Response) => {
  const userId = String(req.user!._id);
  const workspaces = await listWorkspacesForUser(userId);
  return res.json({ workspaces });
});

workspacesRouter.post("/workspaces", requireAuth, async (req: Request, res: Response) => {
  const body = parseBody(
    z.object({
      name: z.string().trim().min(1).max(120),
      type: z.enum(["team", "agency"]).optional(),
    }),
    req.body,
  );
  const workspace = await createWorkspace({
    name: body.name,
    ownerUserId: String(req.user!._id),
    type: body.type ?? "team",
  });
  return res.status(201).json({
    workspace: {
      id: String(workspace._id),
      name: workspace.name,
      slug: workspace.slug,
      type: workspace.type,
      plan: workspace.plan,
      role: "owner",
    },
  });
});

workspacesRouter.get(
  "/workspaces/:workspaceId",
  requireAuth,
  resolveWorkspaceMember,
  async (req: Request, res: Response) => {
    const workspace = await getWorkspaceForUser(String(req.user!._id), wsId(req));
    return res.json({
      workspace: {
        id: String(workspace._id),
        name: workspace.name,
        slug: workspace.slug,
        type: workspace.type,
        plan: workspace.plan,
        role: req.workspaceMember!.role,
        owner: String(workspace.owner),
        createdAt: workspace.createdAt,
      },
    });
  },
);

workspacesRouter.patch(
  "/workspaces/:workspaceId",
  requireAuth,
  resolveWorkspaceMember,
  requireRole("admin"),
  async (req: Request, res: Response) => {
    const body = parseBody(z.object({ name: z.string().trim().min(1).max(120) }), req.body);
    const workspace = await renameWorkspace(wsId(req), body.name);
    return res.json({ workspace: { id: String(workspace._id), name: workspace.name } });
  },
);

workspacesRouter.delete(
  "/workspaces/:workspaceId",
  requireAuth,
  resolveWorkspaceMember,
  requireRole("owner"),
  async (req: Request, res: Response) => {
    await deleteWorkspaceIfEmpty(wsId(req));
    return res.status(204).send();
  },
);

// ---------------------------------------------------------------------------
// Members + RBAC
// ---------------------------------------------------------------------------

workspacesRouter.get(
  "/workspaces/:workspaceId/members",
  requireAuth,
  resolveWorkspaceMember,
  async (req: Request, res: Response) => {
    const members = await listMembers(wsId(req));
    return res.json({ members: members.map(memberJson) });
  },
);

workspacesRouter.post(
  "/workspaces/:workspaceId/members",
  requireAuth,
  resolveWorkspaceMember,
  requireRole("admin"),
  async (req: Request, res: Response) => {
    const body = parseBody(
      z.object({
        userId: idSchema,
        role: z.enum(["admin", "developer", "viewer"]),
      }),
      req.body,
    );
    const member = await addMember({
      workspaceId: wsId(req),
      targetUserId: body.userId,
      role: body.role as WorkspaceRole,
    });
    return res.status(201).json({ member: memberJson(member) });
  },
);

workspacesRouter.patch(
  "/workspaces/:workspaceId/members/:userId",
  requireAuth,
  resolveWorkspaceMember,
  requireRole("admin"),
  async (req: Request, res: Response) => {
    const body = parseBody(z.object({ role: z.enum(["admin", "developer", "viewer"]) }), req.body);
    const member = await changeMemberRole({
      actorUserId: String(req.user!._id),
      actorRole: req.workspaceMember!.role,
      workspaceId: wsId(req),
      targetUserId: memberId(req),
      role: body.role as WorkspaceRole,
    });
    return res.json({ member: memberJson(member) });
  },
);

workspacesRouter.delete(
  "/workspaces/:workspaceId/members/:userId",
  requireAuth,
  resolveWorkspaceMember,
  requireRole("admin"),
  async (req: Request, res: Response) => {
    await removeMember({
      workspaceId: wsId(req),
      targetUserId: memberId(req),
    });
    return res.status(204).send();
  },
);

// ---------------------------------------------------------------------------
// Provider connections + repository registry
// ---------------------------------------------------------------------------

workspacesRouter.get(
  "/workspaces/:workspaceId/provider-connections",
  requireAuth,
  resolveWorkspaceMember,
  async (req: Request, res: Response) => {
    const connections = await listProviderConnections(wsId(req));
    return res.json({ connections });
  },
);

/**
 * Register the caller's current session credentials as a workspace provider
 * connection. Secrets come from the authenticated session (never the body).
 */
workspacesRouter.post(
  "/workspaces/:workspaceId/provider-connections",
  requireAuth,
  resolveWorkspaceMember,
  requireRole("admin"),
  async (req: Request, res: Response) => {
    const body = parseBody(z.object({ provider: z.enum(["github"]) }), req.body);
    if (body.provider !== "github") {
      throw AppError.badRequest("Only github connections are supported");
    }
    const tokenEnc = req.githubTokenEnc;
    if (!tokenEnc) {
      throw AppError.badRequest("No GitHub credentials on the current session — reconnect GitHub first");
    }
    const user = req.user!;
    const existing = await ProviderConnection.findOne({
      workspaceId: wsId(req),
      provider: "github",
      kind: "oauth-user",
      providerAccountId: user.githubId,
    });
    if (existing) {
      return res.status(200).json({
        connection: {
          id: String(existing._id),
          provider: existing.provider,
          kind: existing.kind,
          providerAccountId: existing.providerAccountId,
          providerAccountLogin: existing.providerAccountLogin,
          status: existing.status,
        },
      });
    }
    const connection = await ProviderConnection.create({
      workspaceId: wsId(req),
      provider: "github",
      kind: "oauth-user",
      connectedByUserId: user._id,
      providerAccountId: user.githubId,
      providerAccountLogin: user.username,
      scopes: [],
      credentialsEncrypted: tokenEnc,
      status: "connected",
    });
    return res.status(201).json({
      connection: {
        id: String(connection._id),
        provider: connection.provider,
        kind: connection.kind,
        providerAccountId: connection.providerAccountId,
        providerAccountLogin: connection.providerAccountLogin,
        status: connection.status,
      },
    });
  },
);

workspacesRouter.get(
  "/workspaces/:workspaceId/repositories",
  requireAuth,
  resolveWorkspaceMember,
  async (req: Request, res: Response) => {
    const repositories = await listRepositories(wsId(req));
    return res.json({
      repositories: repositories.map(r => ({
        id: String(r._id),
        provider: r.provider,
        providerExternalId: r.providerExternalId,
        owner: r.ownerLabels.account,
        fullName: r.ownerLabels.fullName,
        name: r.name,
        visibility: r.visibility,
        archived: r.archived,
        defaultBranch: r.defaultBranch,
        syncState: r.syncState,
        lastSyncedAt: r.lastSyncedAt,
      })),
    });
  },
);

workspacesRouter.post(
  "/workspaces/:workspaceId/repositories/register",
  requireAuth,
  resolveWorkspaceMember,
  requireRole("developer"),
  async (req: Request, res: Response) => {
    const body = parseBody(
      z.object({
        providerConnectionId: idSchema,
        provider: z.enum(["github", "bitbucket"]),
        providerExternalId: z.string().min(1).max(128),
        ownerAccount: z.string().min(1).max(200),
        fullName: z.string().min(1).max(300),
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(2000).nullish(),
        visibility: z.enum(["public", "private", "internal"]).optional(),
        archived: z.boolean().optional(),
        defaultBranch: z.string().max(300).nullish(),
      }),
      req.body,
    );
    const repository = await registerRepository({
      workspaceId: wsId(req),
      providerConnectionId: body.providerConnectionId,
      repo: {
        provider: body.provider,
        providerExternalId: body.providerExternalId,
        ownerAccount: body.ownerAccount,
        fullName: body.fullName,
        name: body.name,
        description: body.description ?? null,
        visibility: body.visibility,
        archived: body.archived,
        defaultBranch: body.defaultBranch ?? null,
      },
    });
    return res.status(201).json({
      repository: {
        id: String(repository._id),
        provider: repository.provider,
        fullName: repository.ownerLabels.fullName,
        syncState: repository.syncState,
      },
    });
  },
);

// ---------------------------------------------------------------------------
// Sync + repository-scoped pull requests (mirror-backed; roadmap M2)
// ---------------------------------------------------------------------------

const repoIdOf = (req: Request) => paramOf(req, "repoId");

type PullJsonInput = {
  _id: unknown;
  number: number;
  title: string;
  state: PullRequestState;
  isDraft: boolean;
  author: { login: string; avatarUrl?: string | null };
  sourceBranch: string;
  destinationBranch: string;
  url: string;
  additions: number;
  deletions: number;
  headSha?: string | null;
  checkStatus: string;
  lastSeenAt?: Date;
};

async function loadRepository(workspaceId: string, repoId: string): Promise<RepositoryDocument> {
  if (!idSchema.safeParse(repoId).success) throw AppError.badRequest("Invalid repository id");
  const repository = await Repository.findOne({ _id: repoId, workspaceId });
  if (!repository) throw AppError.notFound("Repository not found");
  return repository;
}

function pullJson(pr: PullJsonInput, repository?: { id: string; fullName: string; name: string }) {
  return {
    id: String(pr._id),
    number: pr.number,
    title: pr.title,
    state: pr.state,
    isDraft: pr.isDraft,
    author: { login: pr.author.login, avatarUrl: pr.author.avatarUrl ?? null },
    sourceBranch: pr.sourceBranch,
    destinationBranch: pr.destinationBranch,
    url: pr.url,
    additions: pr.additions,
    deletions: pr.deletions,
    headSha: pr.headSha ?? null,
    checkStatus: pr.checkStatus,
    lastSeenAt: pr.lastSeenAt ?? null,
    ...(repository ? { repository } : {}),
  };
}

/** Sync-on-demand: refresh the repository mirror + its pull requests from the provider. */
workspacesRouter.post(
  "/workspaces/:workspaceId/repositories/:repoId/sync",
  requireAuth,
  resolveWorkspaceMember,
  requireRole("developer"),
  async (req: Request, res: Response) => {
    const repository = await loadRepository(wsId(req), repoIdOf(req));
    const provider = await providerForWorkspace(wsId(req), repository.provider);
    const updated = await syncRepositoryRecord(repository, provider);
    const { synced } = await syncRepositoryPullRequests(updated, provider);
    return res.json({
      repository: {
        id: String(updated._id),
        fullName: updated.ownerLabels.fullName,
        defaultBranch: updated.defaultBranch,
        syncState: updated.syncState,
        lastSyncedAt: updated.lastSyncedAt,
      },
      pullRequestsSynced: synced,
    });
  },
);

/** Repository-scoped PR list (all authors, state filter, paged) — reads the mirror. */
workspacesRouter.get(
  "/workspaces/:workspaceId/repositories/:repoId/pulls",
  requireAuth,
  resolveWorkspaceMember,
  async (req: Request, res: Response) => {
    const repository = await loadRepository(wsId(req), repoIdOf(req));
    const body = parseBody(
      z.object({
        state: z.enum(["open", "closed", "merged", "all"]).default("open"),
        page: z.coerce.number().int().min(1).default(1),
        perPage: z.coerce.number().int().min(1).max(100).default(25),
      }),
      req.query,
    );
    const filter: Record<string, unknown> = { workspaceId: wsId(req), repositoryId: repository._id };
    if (body.state !== "all") filter.state = body.state;

    const perPage = body.perPage;
    const rows = (await PullRequest.find(filter)
      .sort({ lastSeenAt: -1, number: -1 })
      .skip((body.page - 1) * perPage)
      .limit(perPage + 1)
      .lean()) as unknown as PullJsonInput[];
    const hasNext = rows.length > perPage;
    return res.json({
      pulls: rows.slice(0, perPage).map(pr => pullJson(pr)),
      page: body.page,
      hasNext,
      repository: { id: String(repository._id), fullName: repository.ownerLabels.fullName },
    });
  },
);

/** Global PR inbox for the workspace — deduped across repositories via the mirror. */
workspacesRouter.get(
  "/workspaces/:workspaceId/pulls",
  requireAuth,
  resolveWorkspaceMember,
  async (req: Request, res: Response) => {
    const body = parseBody(
      z.object({
        state: z.enum(["open", "closed", "merged", "all"]).default("open"),
        page: z.coerce.number().int().min(1).default(1),
        perPage: z.coerce.number().int().min(1).max(100).default(25),
      }),
      req.query,
    );
    const filter: Record<string, unknown> = { workspaceId: wsId(req) };
    if (body.state !== "all") filter.state = body.state;

    const perPage = body.perPage;
    const rows = (await PullRequest.find(filter)
      .sort({ lastSeenAt: -1 })
      .skip((body.page - 1) * perPage)
      .limit(perPage + 1)
      .populate("repositoryId", "ownerLabels name")
      .lean()) as unknown as Array<PullJsonInput & {
      repositoryId?: { ownerLabels?: { fullName?: string }; name?: string } | null;
    }>;
    const hasNext = rows.length > perPage;
    return res.json({
      pulls: rows.slice(0, perPage).map(pr =>
        pullJson(pr, {
          id: String((pr.repositoryId as unknown as { _id?: string })?._id ?? pr.repositoryId ?? ""),
          fullName: pr.repositoryId?.ownerLabels?.fullName ?? "",
          name: pr.repositoryId?.name ?? "",
        }),
      ),
      page: body.page,
      hasNext,
    });
  },
);
