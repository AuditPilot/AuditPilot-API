import type { CapabilityKey, ProviderName } from "./types";

/**
 * Per-provider capability maps. Business logic gates provider-specific behavior
 * via `provider.capabilities.has(KEY)` — scattered provider-conditionals are forbidden
 * (provider-abstraction.md §2).
 */

export const GITHUB_CAPABILITIES: ReadonlySet<CapabilityKey> = new Set<CapabilityKey>([
  "listPullRequests.allAuthors",
  "listPullRequests.stateMerged",
  "pullRequests.draft",
  "pullRequests.comments",
  "pullRequests.reviews",
  "pullRequests.merge",
  "checks.status",
  "webhooks",
  "diff.unified",
  "fileContent.rawAtRef",
  "branch.create",
  "commit.multiFile",
  "repos.listPaginated",
]);

/** Bitbucket Cloud adapter lands in M5 — capabilities finalized then. */
export const BITBUCKET_CAPABILITIES: ReadonlySet<CapabilityKey> = new Set<CapabilityKey>([
  "listPullRequests.allAuthors",
  "listPullRequests.stateMerged",
  "pullRequests.comments",
  "pullRequests.reviews",
  "pullRequests.merge",
  "webhooks",
  "diff.unified",
  "fileContent.rawAtRef",
  "branch.create",
  "commit.multiFile",
  "repos.listPaginated",
]);

export function capabilitiesFor(provider: ProviderName): ReadonlySet<CapabilityKey> {
  switch (provider) {
    case "github":
      return GITHUB_CAPABILITIES;
    case "bitbucket":
      return BITBUCKET_CAPABILITIES;
  }
}
