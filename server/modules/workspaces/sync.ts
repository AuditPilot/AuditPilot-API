import type { RepositoryDocument } from "../../models/Repository";
import { PullRequest } from "../../models/PullRequest";
import { logger } from "../../config/logger";
import type { SourceControlProvider } from "../../integrations/source-control/types";

/**
 * Sync-on-demand population of the Repository / PullRequest mirror tables
 * (roadmap M2; webhook-driven sync supersedes this in M3).
 */

const SYNC_PAGES = 3; // 3 × 100 PRs per sync run — pagination documented as bounded

export async function syncRepositoryRecord(
  repository: RepositoryDocument,
  provider: SourceControlProvider,
): Promise<RepositoryDocument> {
  const [ownerAccount] = repository.ownerLabels.fullName.split("/");
  const external = await provider.fetchRepository(ownerAccount, repository.name);

  repository.name = external.name;
  repository.ownerLabels = { account: external.ownerAccount, fullName: external.fullName };
  repository.description = external.description;
  repository.visibility = external.visibility ?? repository.visibility;
  repository.archived = external.archived;
  repository.defaultBranch = external.defaultBranch;
  repository.syncState = "active";
  repository.lastSyncedAt = new Date();
  await repository.save();
  return repository;
}

export async function syncRepositoryPullRequests(
  repository: RepositoryDocument,
  provider: SourceControlProvider,
  opts?: { maxPages?: number },
): Promise<{ synced: number }> {
  const [ownerAccount] = repository.ownerLabels.fullName.split("/");
  const maxPages = opts?.maxPages ?? SYNC_PAGES;
  let synced = 0;

  for (let page = 1; page <= maxPages; page++) {
    const { items, hasNext } = await provider.listPullRequests(ownerAccount, repository.name, {
      state: "all",
      perPage: 100,
      page,
      sort: "updated",
      direction: "desc",
    });

    for (const pr of items) {
      await PullRequest.updateOne(
        { repositoryId: repository._id, provider: repository.provider, number: pr.number },
        {
          $set: {
            workspaceId: repository.workspaceId,
            providerExternalId: pr.providerExternalId,
            title: pr.title,
            author: {
              login: pr.author?.login || "ghost",
              avatarUrl: pr.author?.avatarUrl ?? null,
            },
            sourceBranch: pr.sourceBranch,
            destinationBranch: pr.destinationBranch,
            state: pr.state,
            isDraft: pr.isDraft,
            url: pr.url ?? "",
            additions: pr.additions ?? 0,
            deletions: pr.deletions ?? 0,
            headSha: pr.headSha,
            lastSeenAt: new Date(),
          },
        },
        { upsert: true },
      );
      synced++;
    }

    if (!hasNext) break;
  }

  logger.info(
    { repositoryId: String(repository._id), provider: repository.provider, synced },
    "pull requests synced to mirror",
  );
  return { synced };
}
