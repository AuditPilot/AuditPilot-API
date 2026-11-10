import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import type { Express } from "express";
import { startTestDb, stopTestDb } from "../../test/helpers/db";
import { ENV } from "../../config/env";
import { User, type UserDocument } from "../../models/User";
import { Workspace } from "../../models/Workspace";
import { WorkspaceMember } from "../../models/WorkspaceMember";
import { ProviderConnection } from "../../models/ProviderConnection";
import { Repository } from "../../models/Repository";
import { PullRequest } from "../../models/PullRequest";
import { encryptSecret } from "../../lib/crypto";
import { app } from "../../app";
import { providerForWorkspace } from "./provider-resolution";
import type { ScmPullRequestSummary, ScmRepository, SourceControlProvider } from "../../integrations/source-control/types";

/**
 * Sync + mirror endpoints (M2). The provider is mocked at the resolution
 * boundary — everything below it (mirror upserts, RBAC, pagination, inbox
 * dedupe) runs for real against the test database.
 */

vi.mock("./provider-resolution", () => ({
  providerForWorkspace: vi.fn(),
  providerForUser: vi.fn(),
}));

function fakeProvider(repo: Partial<ScmRepository>, first: Partial<ScmPullRequestSummary>, second: Partial<ScmPullRequestSummary>): SourceControlProvider {
  const pull = (base: Partial<ScmPullRequestSummary>, n: number, title: string, login: string, state: ScmPullRequestSummary["state"]): ScmPullRequestSummary =>
    ({
      providerExternalId: `PR_${n}`,
      number: n,
      title,
      author: { login, avatarUrl: null },
      sourceBranch: `b${n}`,
      destinationBranch: "main",
      state,
      isDraft: false,
      url: `https://x/${n}`,
      additions: n,
      deletions: n * 2,
      headSha: `sha-${n}`,
      ...base,
    }) as ScmPullRequestSummary;
  return {
    name: "github",
    capabilities: new Set(),
    fetchRepository: () =>
      Promise.resolve({
        providerExternalId: "node-repo-1",
        provider: "github",
        ownerAccount: "octocat",
        fullName: "octocat/synced-repo",
        name: "synced-repo",
        description: "synced description",
        visibility: "private",
        archived: false,
        defaultBranch: "trunk",
        htmlUrl: "https://github.com/octocat/synced-repo",
        ...repo,
      } as ScmRepository),
    listPullRequests: () =>
      Promise.resolve({
        items: [
          pull(first, 1, "First PR", "alice", "open"),
          pull(second, 2, "Second PR", "bob", "merged"),
        ],
        page: 1,
        hasNext: false,
      }),
  } as unknown as SourceControlProvider;
}

describe("workspace sync + mirror endpoints", () => {
  let appConcrete: Express;
  let owner: UserDocument;
  let viewer: UserDocument;
  let workspaceId: string;
  let repoId: string;
  let repoId2: string;

  const authCookie = (user: UserDocument) => {
    const token = jwt.sign({ userId: String(user._id) }, ENV.JWT_SECRET as string, { expiresIn: "1h" });
    return `audit_token=${token}`;
  };

  beforeAll(async () => {
    await startTestDb("sync-mirror-test");
    appConcrete = app as Express;

    owner = (await User.create({ githubId: "300001", username: "sync-owner" })) as unknown as UserDocument;
    viewer = (await User.create({ githubId: "300002", username: "sync-viewer" })) as unknown as UserDocument;

    const ws = (await Workspace.create({ name: "Sync Lab", slug: "sync-lab", owner: owner._id, type: "team" })) as unknown as { _id: { toString(): string } };
    workspaceId = ws._id.toString();
    await WorkspaceMember.create({ workspaceId, userId: owner._id, role: "owner", status: "active", joinedAt: new Date() });
    await WorkspaceMember.create({ workspaceId, userId: viewer._id, role: "viewer", status: "active", joinedAt: new Date() });
    await ProviderConnection.create({
      workspaceId,
      provider: "github",
      kind: "oauth-user",
      connectedByUserId: owner._id,
      providerAccountId: "300001",
      providerAccountLogin: "sync-owner",
      scopes: [],
      credentialsEncrypted: encryptSecret("sync-token"),
      status: "connected",
    });

    const conn = await ProviderConnection.findOne({ workspaceId });
    const r1 = (await Repository.create({
      workspaceId,
      providerConnectionId: conn!._id,
      provider: "github",
      providerExternalId: "node-repo-1",
      ownerLabels: { account: "octocat", fullName: "octocat/synced-repo" },
      name: "synced-repo",
      syncState: "pending",
    })) as unknown as { _id: { toString(): string } };
    const r2 = (await Repository.create({
      workspaceId,
      providerConnectionId: conn!._id,
      provider: "github",
      providerExternalId: "node-repo-2",
      ownerLabels: { account: "octocat", fullName: "octocat/second-repo" },
      name: "second-repo",
      syncState: "pending",
    })) as unknown as { _id: { toString(): string } };
    repoId = r1._id.toString();
    repoId2 = r2._id.toString();
  }, 60_000);

  afterAll(async () => {
    await stopTestDb();
  }, 60_000);

  it("viewer cannot trigger a sync (developer role required)", async () => {
    vi.mocked(providerForWorkspace).mockResolvedValue(fakeProvider({}, {}, {}));
    const res = await request(appConcrete)
      .post(`/api/workspaces/${workspaceId}/repositories/${repoId}/sync`)
      .set("Cookie", authCookie(viewer));
    expect(res.status).toBe(403);
  });

  it("syncs the repository mirror + pull requests (upsert), then re-sync converges", async () => {
    vi.mocked(providerForWorkspace).mockResolvedValue(fakeProvider({}, {}, {}));

    const first = await request(appConcrete)
      .post(`/api/workspaces/${workspaceId}/repositories/${repoId}/sync`)
      .set("Cookie", authCookie(owner));
    expect(first.status).toBe(200);
    expect(first.body.repository).toMatchObject({ fullName: "octocat/synced-repo", syncState: "active", defaultBranch: "trunk" });
    expect(first.body.pullRequestsSynced).toBe(2);

    const repo = await Repository.findById(repoId).lean();
    expect(repo?.syncState).toBe("active");
    expect(repo?.lastSyncedAt).toBeTruthy();

    const mirror = await PullRequest.find({ repositoryId: repoId }).lean();
    expect(mirror).toHaveLength(2);
    expect(mirror.map(p => p.state).sort()).toEqual(["merged", "open"]);

    // Re-sync: same mirror rows (upsert), no duplicates
    const second = await request(appConcrete)
      .post(`/api/workspaces/${workspaceId}/repositories/${repoId}/sync`)
      .set("Cookie", authCookie(owner));
    expect(second.status).toBe(200);
    const mirrorAfter = await PullRequest.find({ repositoryId: repoId }).lean();
    expect(mirrorAfter).toHaveLength(2);
    expect(mirrorAfter.map(p => String(p._id)).sort()).toEqual(mirror.map(p => String(p._id)).sort());
  });

  it("repo-scoped PR list: state filter + pagination on the mirror", async () => {
    vi.mocked(providerForWorkspace).mockResolvedValue(fakeProvider({}, {}, {}));

    const openOnly = await request(appConcrete)
      .get(`/api/workspaces/${workspaceId}/repositories/${repoId}/pulls?state=open`)
      .set("Cookie", authCookie(viewer));
    expect(openOnly.status).toBe(200);
    expect(openOnly.body.pulls).toHaveLength(1);
    expect(openOnly.body.pulls[0].state).toBe("open");

    const mergedOnly = await request(appConcrete)
      .get(`/api/workspaces/${workspaceId}/repositories/${repoId}/pulls?state=merged`)
      .set("Cookie", authCookie(viewer));
    expect(mergedOnly.body.pulls[0].author.login).toBe("bob");

    const paged = await request(appConcrete)
      .get(`/api/workspaces/${workspaceId}/repositories/${repoId}/pulls?state=all&perPage=1&page=2`)
      .set("Cookie", authCookie(viewer));
    expect(paged.body.pulls).toHaveLength(1);
    expect(paged.body.page).toBe(2);
    expect(paged.body.hasNext).toBe(false);
  });

  it("workspace inbox aggregates PRs across repositories, deduped, newest first", async () => {
    // Seed the second repository's mirror directly
    await PullRequest.create({
      workspaceId,
      repositoryId: repoId2,
      provider: "github",
      number: 9,
      title: "Second repo PR",
      author: { login: "carol" },
      sourceBranch: "x",
      destinationBranch: "main",
      state: "open",
      url: "https://x/9",
    });
    // And backdate one repo1 PR so the fresh second-repo PR sorts first
    await PullRequest.updateOne(
      { repositoryId: repoId, number: 1 },
      { $set: { lastSeenAt: new Date(Date.now() - 60_000) } },
    );

    const res = await request(appConcrete)
      .get(`/api/workspaces/${workspaceId}/pulls?state=all`)
      .set("Cookie", authCookie(viewer));
    expect(res.status).toBe(200);
    expect(res.body.pulls).toHaveLength(3);
    expect(
      res.body.pulls.map((p: { repository?: { fullName?: string } }) => p.repository?.fullName),
    ).toContain("octocat/second-repo");
    expect(res.body.pulls[0].title).toBe("Second repo PR");
  });

  it("outsider cannot list workspace pulls (404-shaped isolation)", async () => {
    const outsider = (await User.create({ githubId: "300003", username: "sync-outsider" })) as unknown as UserDocument;
    vi.mocked(providerForWorkspace).mockResolvedValue(fakeProvider({}, {}, {}));
    const res = await request(appConcrete)
      .get(`/api/workspaces/${workspaceId}/pulls`)
      .set("Cookie", authCookie(outsider));
    expect(res.status).toBe(404);
  });
});
