/**
 * M1 workspace-foundation migration.
 *
 * For every user, idempotently:
 *   1. Provision a personal workspace (+ owner membership).
 *   2. Clone the user's encrypted GitHub token into a ProviderConnection
 *      (oauth-user kind) on that workspace — credentials are never decrypted
 *      unless repository seeding needs the network.
 *   3. Seed the repository registry from GitHub /user/repos (≤100, sorted by
 *      recent activity). GitHub failures are logged and skipped — a re-run
 *      heals them; nothing else depends on seeding succeeding.
 *   4. Report legacy audit counts as `legacy-unlinked` (they are NOT
 *      backfilled — historical records lack enough data to unambiguously
 *      associate a repository).
 *
 * Idempotency: existing personal workspaces / owner memberships / connections
 * are detected and skipped; repository upserts are keyed on
 * {workspaceId, provider, providerExternalId} and converge to one row.
 *
 * Usage:
 *   npm run migrate:workspaces            # applies
 *   DRY_RUN=1 npm run migrate:workspaces  # reports only, no writes
 *   SKIP_GITHUB_SEED=1 ...                # DB-only pass (no outbound calls)
 */
import "dotenv/config";
import mongoose from "mongoose";
import { User } from "../server/models/User";
import { Workspace } from "../server/models/Workspace";
import { WorkspaceMember } from "../server/models/WorkspaceMember";
import { ProviderConnection } from "../server/models/ProviderConnection";
import { Repository } from "../server/models/Repository";
import { Audit } from "../server/models/Audit";
import { ensurePersonalWorkspace, slugify } from "../server/modules/workspaces/service";
import { encryptSecret, decryptSecret } from "../server/lib/crypto";
import { GitHubClient, GitHubApiError } from "../server/integrations/github/client";

const log = console.log;

interface GitHubApiRepo {
  id: number;
  node_id?: string;
  name: string;
  full_name: string;
  private: boolean;
  archived: boolean;
  description: string | null;
  default_branch: string | null;
  owner?: { login?: string };
}

async function main(): Promise<void> {
  const dryRun = process.env.DRY_RUN === "1";
  const skipGithub = process.env.SKIP_GITHUB_SEED === "1";
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/audit-pilot";
  log(`[migrate-workspaces] connecting to ${uri.replace(/:([^@]+)@/, ":****@")}`);
  if (dryRun) log("[migrate-workspaces] DRY RUN — no writes will be performed.");

  await mongoose.connect(uri);

  const users = await User.find({}).cursor();
  const totals = {
    workspaces: 0,
    memberships: 0,
    connections: 0,
    repositories: 0,
    legacyUnlinkedAudits: 0,
    githubFailures: 0,
  };

  for await (const user of users) {
    const userId = String(user._id);

    // 1+1. Personal workspace + owner membership (idempotent)
    let workspace = await Workspace.findOne({ owner: userId, type: "personal" });
    if (!workspace) {
      if (dryRun) {
        log(`[dry] would create personal workspace for ${user.username}`);
        totals.workspaces++;
        continue;
      }
      const created = await ensurePersonalWorkspace({ _id: user._id, username: user.username });
      const refreshed = await Workspace.findById(created._id);
      if (!refreshed) {
        log(`[warn] ${user.username}: workspace vanished mid-migration — skipping user`);
        continue;
      }
      workspace = refreshed;
      totals.workspaces++;
    } else {
      // Heal a missing owner membership (e.g. interrupted earlier run)
      const membership = await WorkspaceMember.findOne({ workspaceId: workspace._id, userId });
      if (!membership) {
        if (dryRun) {
          log(`[dry] would add owner membership for ${user.username}`);
        } else {
          await WorkspaceMember.create({
            workspaceId: workspace._id,
            userId,
            role: "owner",
            status: "active",
            joinedAt: new Date(),
          });
          totals.memberships++;
        }
      }
    }

    // 2. ProviderConnection cloned from the user's stored GitHub token
    let connection = await ProviderConnection.findOne({
      workspaceId: workspace._id,
      provider: "github",
      kind: "oauth-user",
      providerAccountId: user.githubId,
    });

    const tokenSource = user.accessTokenEncrypted ?? user.accessToken;
    if (!connection && tokenSource) {
      if (dryRun) {
        log(`[dry] would create github connection for ${user.username}`);
        totals.connections++;
      } else {
        const envelope =
          user.accessTokenEncrypted ?? encryptSecret(user.accessToken as string);
        connection = await ProviderConnection.create({
          workspaceId: workspace._id,
          provider: "github",
          kind: "oauth-user",
          connectedByUserId: user._id,
          providerAccountId: user.githubId,
          providerAccountLogin: user.username,
          providerAccountType: "User",
          scopes: [],
          credentialsEncrypted: envelope,
          status: "connected",
        });
        totals.connections++;
      }
    }

    // 3. Repository registry seed (best-effort; requires decrypted token)
    if (connection && !dryRun && !skipGithub && !user.accessToken) {
      let token: string | null = null;
      try {
        token = decryptSecret(connection.credentialsEncrypted);
      } catch {
        log(`[warn] ${user.username}: connection credentials undecryptable — skipping repo seed`);
        totals.githubFailures++;
      }
      if (token) {
        try {
          const gh = new GitHubClient(token);
          const repos = await gh.get<GitHubApiRepo[]>("/user/repos?sort=updated&per_page=100");
          for (const repo of repos.slice(0, 100)) {
            const externalId = repo.node_id ?? String(repo.id);
            await Repository.updateOne(
              {
                workspaceId: workspace._id,
                provider: "github",
                providerExternalId: externalId,
              },
              {
                $set: {
                  providerConnectionId: connection._id,
                  ownerLabels: {
                    account: repo.owner?.login ?? repo.full_name.split("/")[0],
                    fullName: repo.full_name,
                  },
                  name: repo.name,
                  description: repo.description ?? null,
                  visibility: repo.private ? "private" : "public",
                  archived: repo.archived,
                  defaultBranch: repo.default_branch ?? null,
                  lastSyncedAt: new Date(),
                },
                $setOnInsert: { syncState: "active" },
              },
              { upsert: true },
            );
            totals.repositories++;
          }
        } catch (err) {
          const status = err instanceof GitHubApiError ? err.status : undefined;
          if (status === 401 && connection.status === "connected") {
            // Token revoked/expired — record honestly, keep creds for re-auth
            await ProviderConnection.updateOne(
              { _id: connection._id },
              { $set: { status: "error" } },
            );
          }
          log(`[warn] ${user.username}: repository seed failed (${(err as Error).message})`);
          totals.githubFailures++;
        }
      }
    }

    // 4. Legacy audit report (never backfilled)
    const legacyAudits = await Audit.countDocuments({
      userId: user._id,
      workspaceId: null,
    });
    totals.legacyUnlinkedAudits += legacyAudits;
  }

  log(
    `[migrate-workspaces] done${dryRun ? " (DRY RUN)" : ""}: ` +
      `workspaces=${totals.workspaces}, memberships=${totals.memberships}, ` +
      `connections=${totals.connections}, repositories=${totals.repositories}, ` +
      `legacy-unlinked audits=${totals.legacyUnlinkedAudits}, github-failures=${totals.githubFailures}`,
  );
  log(
    `[migrate-workspaces] note: slugify fallback in use for non-alphanumeric usernames ` +
      `(slug base: e.g. ${slugify("weird username!")})`,
  );

  await mongoose.disconnect();
}

main().catch(err => {
  log(`[migrate-workspaces] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
