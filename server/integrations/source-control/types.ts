/**
 * Normalized source-control models + provider interface.
 *
 * This file is the authoritative contract from docs/architecture/provider-abstraction.md §3/§4.
 * Adapters map external provider payloads into these shapes; unknown/nullable provider
 * fields map to explicit `null` — never fabricated. No provider SDK types cross the boundary.
 */

export type ProviderName = "github" | "bitbucket";

export interface ScmRepository {
  /** Stable identity: repo node id (GitHub) / uuid (Bitbucket) — survives renames. */
  providerExternalId: string;
  provider: ProviderName;
  /** Display account/org. */
  ownerAccount: string;
  /** "owner/repo" display + lookup key. */
  fullName: string;
  name: string;
  description: string | null;
  visibility: "public" | "private" | "internal" | null;
  archived: boolean;
  defaultBranch: string | null;
  htmlUrl: string | null;
}

export interface ScmBranch {
  name: string;
  commitSha: string | null;
  isDefault: boolean;
}

export interface ScmPullRequestSummary {
  providerExternalId: string | null;
  number: number;
  title: string;
  author: { login: string; avatarUrl: string | null } | null;
  /** Normalized branch names, no `refs/` prefix. */
  sourceBranch: string;
  destinationBranch: string;
  state: "open" | "closed" | "merged";
  isDraft: boolean;
  url: string | null;
  additions: number | null;
  deletions: number | null;
  headSha: string | null;
}

export interface ScmPullRequestDetail extends ScmPullRequestSummary {
  body: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  mergedAt: string | null;
}

export interface ScmPullRequestFile {
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "removed" | "renamed" | "unknown";
  additions: number;
  deletions: number;
  /** null = too large / binary — MUST remain null at the prompt layer. */
  patch: string | null;
}

export interface ScmCommit {
  sha: string;
  message: string;
  author: string | null;
  date: string | null;
  url: string | null;
}

export interface ScmCommitCheck {
  name: string;
  state: "pending" | "success" | "failure" | "neutral" | "skipped";
  url: string | null;
}

export interface ScmReviewComment {
  id: string;
  author: string | null;
  body: string;
  file: string | null;
  line: number | null;
  createdAt: string | null;
}

export interface ScmDiff {
  diff: string;
  truncated: boolean;
}

export interface ScmWebhookEvent {
  provider: ProviderName;
  /** Normalized: repo.push, pr.opened, pr.updated, pr.closed, pr.merged, review.submitted, check.completed, repo.renamed, repo.deleted, installation.changed */
  type: string;
  /** Provider delivery GUID — idempotency key. */
  deliveryId: string;
  repositoryExternalId: string;
  /** Event-specific id (PR id, commit sha…). */
  externalId: string;
  /** Persisted in the WebhookEvent ledger for replay/forensics. */
  raw: unknown;
}

export interface BranchSpec {
  name: string;
  fromSha?: string;
}

export interface CommitSpec {
  branch: string;
  files: { path: string; content: string }[];
  message: string;
}

export interface PullRequestSpec {
  sourceBranch: string;
  destinationBranch: string;
  title: string;
  body?: string;
  draft?: boolean;
}

export type CapabilityKey =
  | "listPullRequests.allAuthors" // non-author-restricted PR listing
  | "listPullRequests.stateMerged"
  | "pullRequests.draft"
  | "pullRequests.comments"
  | "pullRequests.reviews"
  | "pullRequests.merge"
  | "checks.status" // CI/check states readable
  | "webhooks"
  | "diff.unified"
  | "fileContent.rawAtRef"
  | "branch.create"
  | "commit.multiFile"
  | "repos.listPaginated";

export interface ListPullRequestsFilter {
  state?: "open" | "closed" | "all";
  author?: string;
  draft?: boolean;
  base?: string;
  sort?: "updated" | "created";
  direction?: "asc" | "desc";
  perPage?: number;
  page?: number;
}

export interface SourceControlProvider {
  readonly name: ProviderName;
  readonly capabilities: ReadonlySet<CapabilityKey>;

  // Account/connection
  listAccounts(): Promise<{ id: string; login: string; type: string }[]>;

  // Repositories
  listRepositories(opts?: {
    page?: number;
    perPage?: number;
    affiliation?: "owner" | "collaborator" | "organization_member";
  }): AsyncGenerator<ScmRepository>;
  fetchRepository(owner: string, repo: string): Promise<ScmRepository>;

  // Branches & content
  listBranches(owner: string, repo: string, opts?: { page?: number; perPage?: number }): AsyncGenerator<ScmBranch>;
  fetchFileContent(owner: string, repo: string, path: string, ref?: string): Promise<string | null>;

  // Pull requests
  listPullRequests(
    owner: string,
    repo: string,
    filter: ListPullRequestsFilter,
  ): Promise<{ items: ScmPullRequestSummary[]; page: number; hasNext: boolean }>;
  fetchPullRequest(owner: string, repo: string, number: number): Promise<ScmPullRequestDetail>;
  /** Contract extension (M2): PR metadata updates (title/body/state/base). */
  updatePullRequest(
    owner: string,
    repo: string,
    number: number,
    patch: { title?: string; body?: string; state?: "open" | "closed"; base?: string },
  ): Promise<ScmPullRequestDetail>;
  listPullRequestFiles(
    owner: string,
    repo: string,
    number: number,
    opts?: { perPage?: number; page?: number },
  ): AsyncGenerator<ScmPullRequestFile>;
  fetchPullRequestDiff(owner: string, repo: string, number: number): Promise<ScmDiff>;

  // Commits & checks
  listCommits(
    owner: string,
    repo: string,
    filter?: { sha?: string; path?: string; perPage?: number; page?: number },
  ): Promise<ScmCommit[]>;
  fetchCombinedCheckStatus(
    owner: string,
    repo: string,
    sha: string,
  ): Promise<{ status: "pending" | "passing" | "failing" | "none"; checks: ScmCommitCheck[] } | null>;

  // Comments/reviews
  listPullRequestComments(owner: string, repo: string, number: number): Promise<ScmReviewComment[]>;

  // Write operations (always require write-capable connection + capability)
  createBranch(owner: string, repo: string, spec: BranchSpec): Promise<{ name: string; sha: string }>;
  createCommit(owner: string, repo: string, spec: CommitSpec): Promise<{ sha: string; url: string }>;
  createPullRequest(owner: string, repo: string, spec: PullRequestSpec): Promise<ScmPullRequestSummary>;
  mergePullRequest(
    owner: string,
    repo: string,
    number: number,
    opts: { method: "squash" | "merge" | "rebase"; sha?: string },
  ): Promise<{ merged: boolean; sha: string }>;

  // Webhooks (M3/M5)
  registerWebhook(owner: string, repo: string, events: string[], url: string, secret: string): Promise<{ id: string }>;
}
