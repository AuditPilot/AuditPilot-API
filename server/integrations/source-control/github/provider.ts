import { GITHUB_CAPABILITIES } from "../capabilities";
import type {
  BranchSpec,
  CommitSpec,
  ListPullRequestsFilter,
  ProviderName,
  PullRequestSpec,
  ScmBranch,
  ScmCommit,
  ScmCommitCheck,
  ScmDiff,
  ScmPullRequestDetail,
  ScmPullRequestFile,
  ScmPullRequestSummary,
  ScmRepository,
  ScmReviewComment,
  SourceControlProvider,
  CapabilityKey,
} from "../types";
import { AppError } from "../../../middleware/errorHandler";
import { GitHubApiError } from "../../github/client";

/**
 * GitHub REST adapter (OAuth-user connection for M2; installation tokens in M3).
 * Wraps the existing GitHubClient transport — timeouts, retries and rate-limit
 * handling stay in the transport (provider-abstraction.md §1).
 */

/** Minimal structural transport — GitHubClient satisfies it; tests inject fakes. */
export interface ScmTransport {
  get<T = unknown>(path: string, opts?: { raw?: boolean; accept?: string }): Promise<T>;
  post<T = unknown>(path: string, body: unknown): Promise<T>;
  put<T = unknown>(path: string, body?: unknown): Promise<T>;
  patch<T = string>(path: string, body: unknown): Promise<T>;
  del<T = unknown>(path: string): Promise<T>;
  raw(path: string): Promise<string>;
}

// === GitHub REST payload shapes (never leave this file) ===

interface GhRepo {
  id: number;
  node_id?: string;
  name: string;
  full_name: string;
  owner?: { login?: string };
  description?: string | null;
  private?: boolean;
  archived?: boolean;
  default_branch?: string | null;
  html_url?: string | null;
  visibility?: string;
}

interface GhBranch {
  name: string;
  commit?: { sha?: string };
}

interface GhPull {
  id?: number;
  node_id?: string;
  number: number;
  title?: string;
  state?: string;
  draft?: boolean;
  merged_at?: string | null;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  body?: string | null;
  html_url?: string | null;
  additions?: number | null;
  deletions?: number | null;
  user?: { login?: string; avatar_url?: string | null } | null;
  head?: { ref?: string; sha?: string };
  base?: { ref?: string };
}

interface GhPullFile {
  filename?: string;
  previous_filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
}

interface GhCommit {
  sha?: string;
  html_url?: string;
  commit?: { message?: string; author?: { name?: string; date?: string } };
}

interface GhCombinedStatus {
  state?: string;
  statuses?: { name?: string; context?: string; state?: string; target_url?: string | null }[];
}

interface GhReviewComment {
  id?: number;
  user?: { login?: string } | null;
  body?: string;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  created_at?: string;
}

function mapFileStatus(status: string | undefined): ScmPullRequestFile["status"] {
  switch (status) {
    case "added":
      return "added";
    case "removed":
      return "removed";
    case "modified":
    case "changed":
      return "modified";
    case "renamed":
    case "copied":
      return "renamed";
    default:
      return "unknown";
  }
}

function mapCheckState(state: string | undefined): ScmCommitCheck["state"] {
  switch (state) {
    case "success":
      return "success";
    case "failure":
    case "error":
      return "failure";
    case "pending":
    case "expected":
      return "pending";
    case "neutral":
      return "neutral";
    case "skipped":
      return "skipped";
    default:
      return "pending";
  }
}

function seg(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw AppError.badRequest(`${label} is required`);
  return encodeURIComponent(trimmed);
}

function validateContentPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.endsWith("/")) {
    throw AppError.badRequest("invalid file path");
  }
  const parts = trimmed.split("/");
  if (parts.some(p => p === ".." || p.length === 0)) {
    throw AppError.badRequest("invalid file path");
  }
  return parts.map(encodeURIComponent).join("/");
}

function validateRef(ref: string | undefined): string {
  if (ref === undefined) return "";
  const trimmed = ref.trim();
  if (!trimmed || /[\s\u0000-\u001f]/.test(trimmed) || trimmed.startsWith("-")) {
    throw AppError.badRequest("invalid ref");
  }
  return encodeURIComponent(trimmed);
}

function stateOf(pr: GhPull): ScmPullRequestSummary["state"] {
  if (pr.state === "open") return "open";
  if (pr.merged_at) return "merged";
  return "closed";
}

export class GitHubProvider implements SourceControlProvider {
  readonly name: ProviderName = "github";
  readonly capabilities: ReadonlySet<CapabilityKey> = GITHUB_CAPABILITIES;

  private defaultBranchCache = new Map<string, string | null>();

  constructor(private readonly transport: ScmTransport) {}

  // === Account/connection ===

  async listAccounts(): Promise<{ id: string; login: string; type: string }[]> {
    const user = await this.transport.get<{ id: number; login?: string; type?: string }>("/user");
    return [{ id: String(user.id), login: user.login ?? "", type: user.type ?? "User" }];
  }

  // === Repositories ===

  async *listRepositories(opts?: {
    page?: number;
    perPage?: number;
    affiliation?: "owner" | "collaborator" | "organization_member";
  }): AsyncGenerator<ScmRepository> {
    const perPage = opts?.perPage ?? 100;
    const affiliation = opts?.affiliation;
    let page = opts?.page ?? 1;
    for (;;) {
      const qs = new URLSearchParams({
        sort: "updated",
        per_page: String(perPage),
        page: String(page),
      });
      if (affiliation) qs.set("affiliation", affiliation);
      const items = await this.transport.get<GhRepo[]>(`/user/repos?${qs.toString()}`);
      for (const repo of items) yield this.mapRepo(repo);
      if (items.length < perPage) return;
      page++;
    }
  }

  async fetchRepository(owner: string, repo: string): Promise<ScmRepository> {
    const data = await this.transport.get<GhRepo>(`/repos/${seg(owner, "owner")}/${seg(repo, "repo")}`);
    return this.mapRepo(data);
  }

  private mapRepo(repo: GhRepo): ScmRepository {
    const [ownerAccount] = repo.full_name?.split("/") ?? [repo.owner?.login ?? ""];
    const visibility = repo.visibility === "internal" || repo.visibility === "private" || repo.visibility === "public"
      ? repo.visibility
      : repo.private
        ? "private"
        : "public";
    return {
      providerExternalId: repo.node_id ?? String(repo.id),
      provider: "github",
      ownerAccount: ownerAccount ?? "",
      fullName: repo.full_name ?? `${repo.owner?.login ?? ""}/${repo.name ?? ""}`,
      name: repo.name ?? "",
      description: repo.description ?? null,
      visibility,
      archived: repo.archived ?? false,
      defaultBranch: repo.default_branch ?? null,
      htmlUrl: repo.html_url ?? null,
    };
  }

  // === Branches & content ===

  async *listBranches(owner: string, repo: string, opts?: { page?: number; perPage?: number }): AsyncGenerator<ScmBranch> {
    const perPage = opts?.perPage ?? 100;
    let page = opts?.page ?? 1;
    for (;;) {
      const qs = new URLSearchParams({ per_page: String(perPage), page: String(page) });
      const items = await this.transport.get<GhBranch[]>(`/repos/${seg(owner, "owner")}/${seg(repo, "repo")}/branches?${qs.toString()}`);
      const defaultBranch = await this.defaultBranchOf(owner, repo);
      for (const branch of items) {
        yield {
          name: branch.name,
          commitSha: branch.commit?.sha ?? null,
          isDefault: defaultBranch !== null && branch.name === defaultBranch,
        };
      }
      if (items.length < perPage) return;
      page++;
    }
  }

  private async defaultBranchOf(owner: string, repo: string): Promise<string | null> {
    const key = `${owner}/${repo}`;
    if (this.defaultBranchCache.has(key)) return this.defaultBranchCache.get(key) ?? null;
    try {
      const repoData = await this.fetchRepository(owner, repo);
      this.defaultBranchCache.set(key, repoData.defaultBranch);
      return repoData.defaultBranch;
    } catch {
      this.defaultBranchCache.set(key, null);
      return null;
    }
  }

  async fetchFileContent(owner: string, repo: string, path: string, ref?: string): Promise<string | null> {
    const safePath = validateContentPath(path);
    const safeRef = validateRef(ref);
    const qs = safeRef ? `?ref=${safeRef}` : "";
    try {
      return await this.transport.raw(`/repos/${seg(owner, "owner")}/${seg(repo, "repo")}/contents/${safePath}${qs}`);
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) return null;
      throw err;
    }
  }

  // === Pull requests ===

  async listPullRequests(
    owner: string,
    repo: string,
    filter: ListPullRequestsFilter,
  ): Promise<{ items: ScmPullRequestSummary[]; page: number; hasNext: boolean }> {
    const perPage = filter.perPage ?? 30;
    const page = filter.page ?? 1;
    const qs = new URLSearchParams({
      // "merged" is not a REST filter — closed + merged_at derives it (capability stateMerged)
      state: filter.state ?? "open",
      per_page: String(perPage),
      page: String(page),
    });
    if (filter.draft !== undefined) qs.set("draft", String(filter.draft));
    if (filter.base) qs.set("base", filter.base);
    qs.set("sort", filter.sort ?? "updated");
    qs.set("direction", filter.direction ?? "desc");

    const items = await this.transport.get<GhPull[]>(
      `/repos/${seg(owner, "owner")}/${seg(repo, "repo")}/pulls?${qs.toString()}`,
    );

    return {
      items: items.map(pr => this.mapPullSummary(pr)),
      page,
      // Heuristic: a full page implies more. Exactly-full last page over-reports
      // once; callers page until an empty/partial page.
      hasNext: items.length >= perPage,
    };
  }

  async fetchPullRequest(owner: string, repo: string, number: number): Promise<ScmPullRequestDetail> {
    const pr = await this.transport.get<GhPull>(
      `/repos/${seg(owner, "owner")}/${seg(repo, "repo")}/pulls/${number}`,
    );
    return {
      ...this.mapPullSummary(pr),
      body: pr.body ?? null,
      createdAt: pr.created_at ?? null,
      updatedAt: pr.updated_at ?? null,
      mergedAt: pr.merged_at ?? null,
    };
  }

  private mapPullSummary(pr: GhPull): ScmPullRequestSummary {
    return {
      providerExternalId: pr.node_id ?? (pr.id !== undefined ? String(pr.id) : null),
      number: pr.number,
      title: pr.title ?? "",
      author: pr.user?.login ? { login: pr.user.login, avatarUrl: pr.user.avatar_url ?? null } : null,
      sourceBranch: pr.head?.ref ?? "",
      destinationBranch: pr.base?.ref ?? "",
      state: stateOf(pr),
      isDraft: pr.draft ?? false,
      url: pr.html_url ?? null,
      additions: typeof pr.additions === "number" ? pr.additions : null,
      deletions: typeof pr.deletions === "number" ? pr.deletions : null,
      headSha: pr.head?.sha ?? null,
    };
  }

  async *listPullRequestFiles(
    owner: string,
    repo: string,
    number: number,
    opts?: { perPage?: number; page?: number },
  ): AsyncGenerator<ScmPullRequestFile> {
    const perPage = opts?.perPage ?? 100;
    let page = opts?.page ?? 1;
    for (;;) {
      const qs = new URLSearchParams({ per_page: String(perPage), page: String(page) });
      const items = await this.transport.get<GhPullFile[]>(
        `/repos/${seg(owner, "owner")}/${seg(repo, "repo")}/pulls/${number}/files?${qs.toString()}`,
      );
      for (const file of items) {
        yield {
          path: file.filename ?? "",
          previousPath: file.previous_filename,
          status: mapFileStatus(file.status),
          additions: file.additions ?? 0,
          deletions: file.deletions ?? 0,
          // Explicit null — never the string "undefined" in AI prompts.
          patch: file.patch ?? null,
        };
      }
      if (items.length < perPage) return;
      page++;
    }
  }

  async fetchPullRequestDiff(owner: string, repo: string, number: number): Promise<ScmDiff> {
    const diff = await this.transport.get<string>(
      `/repos/${seg(owner, "owner")}/${seg(repo, "repo")}/pulls/${number}`,
      { accept: "application/vnd.github.v3.diff" },
    );
    return { diff, truncated: false };
  }

  async updatePullRequest(
    owner: string,
    repo: string,
    number: number,
    patch: { title?: string; body?: string; state?: "open" | "closed"; base?: string },
  ): Promise<ScmPullRequestDetail> {
    const pr = await this.transport.patch<GhPull>(
      `/repos/${seg(owner, "owner")}/${seg(repo, "repo")}/pulls/${number}`,
      patch,
    );
    return {
      ...this.mapPullSummary(pr),
      body: pr.body ?? null,
      createdAt: pr.created_at ?? null,
      updatedAt: pr.updated_at ?? null,
      mergedAt: pr.merged_at ?? null,
    };
  }

  // === Commits & checks ===

  async listCommits(
    owner: string,
    repo: string,
    filter?: { sha?: string; path?: string; perPage?: number; page?: number },
  ): Promise<ScmCommit[]> {
    const qs = new URLSearchParams();
    if (filter?.sha) qs.set("sha", filter.sha);
    if (filter?.path) qs.set("path", filter.path);
    qs.set("per_page", String(filter?.perPage ?? 30));
    qs.set("page", String(filter?.page ?? 1));
    const items = await this.transport.get<GhCommit[]>(
      `/repos/${seg(owner, "owner")}/${seg(repo, "repo")}/commits?${qs.toString()}`,
    );
    return items.map(c => ({
      sha: c.sha ?? "",
      message: c.commit?.message ?? "",
      author: c.commit?.author?.name ?? null,
      date: c.commit?.author?.date ?? null,
      url: c.html_url ?? null,
    }));
  }

  async fetchCombinedCheckStatus(
    owner: string,
    repo: string,
    sha: string,
  ): Promise<{ status: "pending" | "passing" | "failing" | "none"; checks: ScmCommitCheck[] } | null> {
    try {
      const data = await this.transport.get<GhCombinedStatus>(
        `/repos/${seg(owner, "owner")}/${seg(repo, "repo")}/commits/${seg(sha, "sha")}/status`,
      );
      const checks: ScmCommitCheck[] = (data.statuses ?? []).map(s => ({
        name: s.context ?? s.name ?? "",
        state: mapCheckState(s.state),
        url: s.target_url ?? null,
      }));
      let status: "pending" | "passing" | "failing" | "none" = "none";
      if (data.state === "success") status = "passing";
      else if (data.state === "failure" || data.state === "error") status = "failing";
      else if (data.state === "pending") status = "pending";
      return { status, checks };
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) return null;
      throw err;
    }
  }

  // === Comments/reviews ===

  async listPullRequestComments(owner: string, repo: string, number: number): Promise<ScmReviewComment[]> {
    const items = await this.transport.get<GhReviewComment[]>(
      `/repos/${seg(owner, "owner")}/${seg(repo, "repo")}/pulls/${number}/comments?per_page=100`,
    );
    return items.map(c => ({
      id: String(c.id ?? ""),
      author: c.user?.login ?? null,
      body: c.body ?? "",
      file: c.path ?? null,
      line: c.line ?? c.original_line ?? null,
      createdAt: c.created_at ?? null,
    }));
  }

  // === Write operations ===

  async createBranch(owner: string, repo: string, spec: BranchSpec): Promise<{ name: string; sha: string }> {
    let fromSha = spec.fromSha;
    if (!fromSha) {
      const defaultBranch = await this.defaultBranchOf(owner, repo);
      if (!defaultBranch) throw AppError.badRequest("unable to resolve default branch");
      const refData = await this.transport.get<{ object?: { sha?: string } }>(
        `/repos/${seg(owner, "owner")}/${seg(repo, "repo")}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
      );
      fromSha = refData.object?.sha;
      if (!fromSha) throw AppError.badRequest("unable to resolve source commit sha");
    }
    await this.transport.post(`/repos/${seg(owner, "owner")}/${seg(repo, "repo")}/git/refs`, {
      ref: `refs/heads/${spec.name}`,
      sha: fromSha,
    });
    return { name: spec.name, sha: fromSha };
  }

  async createCommit(owner: string, repo: string, spec: CommitSpec): Promise<{ sha: string; url: string }> {
    const ownerSeg = seg(owner, "owner");
    const repoSeg = seg(repo, "repo");
    const branchRef = await this.transport.get<{ object?: { sha?: string } }>(
      `/repos/${ownerSeg}/${repoSeg}/git/ref/heads/${encodeURIComponent(spec.branch)}`,
    );
    const headSha = branchRef.object?.sha;
    if (!headSha) throw AppError.badRequest(`branch ${spec.branch} not found`);

    const baseCommit = await this.transport.get<{ tree?: { sha?: string }; html_url?: string }>(
      `/repos/${ownerSeg}/${repoSeg}/git/commits/${headSha}`,
    );
    const tree = await this.transport.post<{ sha?: string; html_url?: string }>(`/repos/${ownerSeg}/${repoSeg}/git/trees`, {
      base_tree: baseCommit.tree?.sha,
      tree: spec.files.map(f => ({ path: f.path, content: f.content, mode: "100644", type: "blob" })),
    });
    if (!tree.sha) throw AppError.badRequest("failed to create tree");
    const commit = await this.transport.post<{ sha?: string; html_url?: string }>(`/repos/${ownerSeg}/${repoSeg}/git/commits`, {
      message: spec.message,
      tree: tree.sha,
      parents: [headSha],
    });
    if (!commit.sha) throw AppError.badRequest("failed to create commit");
    await this.transport.patch(`/repos/${ownerSeg}/${repoSeg}/git/refs/heads/${encodeURIComponent(spec.branch)}`, {
      sha: commit.sha,
    });
    return { sha: commit.sha, url: commit.html_url ?? "" };
  }

  async createPullRequest(owner: string, repo: string, spec: PullRequestSpec): Promise<ScmPullRequestSummary> {
    const pr = await this.transport.post<GhPull>(`/repos/${seg(owner, "owner")}/${seg(repo, "repo")}/pulls`, {
      head: spec.sourceBranch,
      base: spec.destinationBranch,
      title: spec.title,
      body: spec.body,
      draft: spec.draft,
    });
    return this.mapPullSummary(pr);
  }

  async mergePullRequest(
    owner: string,
    repo: string,
    number: number,
    opts: { method: "squash" | "merge" | "rebase"; sha?: string },
  ): Promise<{ merged: boolean; sha: string }> {
    const ownerSeg = seg(owner, "owner");
    const repoSeg = seg(repo, "repo");

    let headBranch = "";
    try {
      const pr = await this.transport.get<GhPull>(`/repos/${ownerSeg}/${repoSeg}/pulls/${number}`);
      headBranch = pr.head?.ref ?? "";
    } catch {
      // proceed without branch info (merge can still happen)
    }

    const result = await this.transport.put<{ merged?: boolean; sha?: string }>(
      `/repos/${ownerSeg}/${repoSeg}/pulls/${number}/merge`,
      {
        commit_title: `AuditPilot: Merging PR #${number}`,
        merge_method: opts.method,
        ...(opts.sha ? { sha: opts.sha } : {}),
      },
    );

    // Temp fix-branch cleanup (moved from the legacy route inline logic)
    if (headBranch && (headBranch.startsWith("audit-") || headBranch.startsWith("auditpilot-fix-"))) {
      await this.transport.del(`/repos/${ownerSeg}/${repoSeg}/git/refs/heads/${encodeURIComponent(headBranch)}`);
    }

    return { merged: result.merged ?? true, sha: result.sha ?? "" };
  }

  // === Webhooks (M3 wires the ledger; the capability exists now) ===

  async registerWebhook(owner: string, repo: string, events: string[], url: string, secret: string): Promise<{ id: string }> {
    const hook = await this.transport.post<{ id?: number }>(`/repos/${seg(owner, "owner")}/${seg(repo, "repo")}/hooks`, {
      name: "web",
      events,
      config: { url, content_type: "json", secret },
    });
    return { id: String(hook.id ?? "") };
  }
}
