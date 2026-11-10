import { describe, it, expect } from "vitest";
import { GitHubProvider, type ScmTransport } from "./provider";
import { GitHubApiError } from "../../github/client";

/**
 * Contract tests over recorded-shape fixtures (provider-abstraction.md §7.1):
 * the adapter must map GitHub REST payloads into normalized models — including
 * the merged-state derivation, null patches, and branch-name normalization —
 * so no provider rawness leaks into business logic.
 */

interface Call {
  method: string;
  path: string;
  body?: unknown;
  opts?: { raw?: boolean; accept?: string };
}

type Responder = (call: Call) => unknown | never;

function fakeTransport(respond: Responder): { transport: ScmTransport; calls: Call[] } {
  const calls: Call[] = [];
  const transport: ScmTransport = {
    async get(path, opts) {
      calls.push({ method: "GET", path, opts });
      return respond({ method: "GET", path, opts }) as never;
    },
    async post(path, body) {
      calls.push({ method: "POST", path, body });
      return respond({ method: "POST", path, body }) as never;
    },
    async put(path, body) {
      calls.push({ method: "PUT", path, body });
      return respond({ method: "PUT", path, body }) as never;
    },
    async patch(path, body) {
      calls.push({ method: "PATCH", path, body });
      return respond({ method: "PATCH", path, body }) as never;
    },
    async del(path) {
      calls.push({ method: "DELETE", path });
      return respond({ method: "DELETE", path }) as never;
    },
    async raw(path) {
      calls.push({ method: "GET", path, opts: { raw: true } });
      return respond({ method: "GET", path, opts: { raw: true } }) as string;
    },
  };
  return { transport, calls };
}

async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

const REPO_FIXTURE = {
  id: 1296269,
  node_id: "MDEwOlJlcG9zaXRvcnkxMjk2MjY5",
  name: "hello-world",
  full_name: "octocat/hello-world",
  owner: { login: "octocat" },
  description: "My first repository",
  private: false,
  archived: false,
  default_branch: "main",
  html_url: "https://github.com/octocat/hello-world",
};

const PULL_FIXTURE = {
  id: 12345,
  node_id: "PR_node_12345",
  number: 7,
  title: "Fix the login flow",
  state: "open",
  draft: false,
  user: { login: "alice", avatar_url: "https://avatars/alice.png" },
  head: { ref: "fix/login", sha: "abc123" },
  base: { ref: "main" },
  html_url: "https://github.com/octocat/hello-world/pull/7",
  additions: 12,
  deletions: 3,
};

describe("GitHubProvider contract", () => {
  it("listRepositories: paged AsyncIterable mapping node_id, visibility, owner", async () => {
    const { transport } = fakeTransport(({ path }) => {
      expect(path).toContain("/user/repos?");
      return [REPO_FIXTURE]; // fewer than per_page → single page
    });
    const provider = new GitHubProvider(transport);
    const repos = await drain(provider.listRepositories({ perPage: 2 }));
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({
      providerExternalId: "MDEwOlJlcG9zaXRvcnkxMjk2MjY5",
      provider: "github",
      ownerAccount: "octocat",
      fullName: "octocat/hello-world",
      defaultBranch: "main",
      visibility: "public",
      archived: false,
    });
  });

  it("listRepositories: pages until a partial page (per_page exhausted)", async () => {
    const fullPage = [REPO_FIXTURE, REPO_FIXTURE];
    let fetched = 0;
    const { transport, calls } = fakeTransport(() => {
      fetched++;
      return fetched < 3 ? fullPage : []; // 2 full pages then empty
    });
    const provider = new GitHubProvider(transport);
    const repos = await drain(provider.listRepositories({ perPage: 2 }));
    expect(repos).toHaveLength(4);
    expect(calls.filter(c => c.path.startsWith("/user/repos")).length).toBe(3);
  });

  it("fetchRepository maps the normalized shape", async () => {
    const { transport } = fakeTransport(({ path }) => {
      expect(path).toBe("/repos/octocat/hello-world");
      return { ...REPO_FIXTURE, private: true, archived: true, visibility: "private" };
    });
    const provider = new GitHubProvider(transport);
    const repo = await provider.fetchRepository("octocat", "hello-world");
    expect(repo.visibility).toBe("private");
    expect(repo.archived).toBe(true);
    expect(repo.description).toBe("My first repository");
  });

  it("listPullRequests: repo-scoped /pulls (all authors), merged derivation, branch normalization", async () => {
    const { transport, calls } = fakeTransport(({ path }) => {
      expect(path).toMatch(/^\/repos\/octocat\/hello-world\/pulls\?/);
      return [
        PULL_FIXTURE,
        { ...PULL_FIXTURE, number: 8, state: "closed", merged_at: "2026-01-15T10:00:00Z" },
        { ...PULL_FIXTURE, number: 9, state: "closed", merged_at: null },
        { ...PULL_FIXTURE, number: 10, user: null, draft: true },
      ];
    });
    const provider = new GitHubProvider(transport);
    const { items, page, hasNext } = await provider.listPullRequests("octocat", "hello-world", {
      state: "all",
      perPage: 30,
      page: 1,
    });
    expect(page).toBe(1);
    expect(hasNext).toBe(false);
    expect(items[0]).toMatchObject({
      providerExternalId: "PR_node_12345",
      number: 7,
      state: "open",
      sourceBranch: "fix/login",
      destinationBranch: "main",
      isDraft: false,
      headSha: "abc123",
      author: { login: "alice", avatarUrl: "https://avatars/alice.png" },
      additions: 12,
      deletions: 3,
    });
    // merged = closed + merged_at (capability listPullRequests.stateMerged)
    expect(items[1].state).toBe("merged");
    expect(items[2].state).toBe("closed");
    expect(items[3].author).toBeNull();
    expect(items[3].isDraft).toBe(true);
    // state/sort/direction are always explicit
    expect(calls[0].path).toContain("state=all");
    expect(calls[0].path).toContain("sort=updated");
    expect(calls[0].path).toContain("direction=desc");
  });

  it("listPullRequests: full page reports hasNext (pagination heuristic)", async () => {
    const { transport } = fakeTransport(() => [PULL_FIXTURE, PULL_FIXTURE]);
    const provider = new GitHubProvider(transport);
    const { hasNext } = await provider.listPullRequests("octocat", "hello-world", { perPage: 2 });
    expect(hasNext).toBe(true);
  });

  it("fetchPullRequest: detail includes body and timestamps", async () => {
    const { transport } = fakeTransport(() => ({
      ...PULL_FIXTURE,
      body: "Closes the login bug",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      merged_at: null,
      closed_at: null,
    }));
    const provider = new GitHubProvider(transport);
    const pr = await provider.fetchPullRequest("octocat", "hello-world", 7);
    expect(pr.body).toBe("Closes the login bug");
    expect(pr.createdAt).toBe("2026-01-01T00:00:00Z");
    expect(pr.state).toBe("open");
  });

  it("listPullRequestFiles: paginated generator; missing patch → null (never 'undefined')", async () => {
    const { transport, calls } = fakeTransport(({ path }) => {
      if (path.includes("page=1")) {
        return [
          { filename: "src/a.ts", status: "modified", additions: 5, deletions: 1, patch: "@@ -1 +1 @@" },
          { filename: "bin/logo.png", status: "removed", additions: 0, deletions: 0 /* no patch — binary/large */ },
        ];
      }
      return [{ filename: "src/b.ts", previous_filename: "src/old.ts", status: "renamed", additions: 2, deletions: 2, patch: "@@ -2 +2 @@" }];
    });
    const provider = new GitHubProvider(transport);
    const files = await drain(provider.listPullRequestFiles("octocat", "hello-world", 7, { perPage: 2 }));
    expect(files).toHaveLength(3);
    expect(files[0]).toMatchObject({ path: "src/a.ts", status: "modified", patch: "@@ -1 +1 @@" });
    // THE prompt-poisoning fix: patch stays null, not the string "undefined"
    expect(files[1].patch).toBeNull();
    expect(files[2]).toMatchObject({ path: "src/b.ts", previousPath: "src/old.ts", status: "renamed" });
    expect(calls.some(c => c.path.includes("per_page=2"))).toBe(true);
  });

  it("fetchPullRequestDiff uses the .diff media type", async () => {
    const { transport, calls } = fakeTransport((call) => {
      expect(call.opts?.accept).toBe("application/vnd.github.v3.diff");
      return "diff --git a/src/a.ts b/src/a.ts";
    });
    const provider = new GitHubProvider(transport);
    const diff = await provider.fetchPullRequestDiff("octocat", "hello-world", 7);
    expect(diff).toEqual({ diff: "diff --git a/src/a.ts b/src/a.ts", truncated: false });
    expect(calls).toHaveLength(1);
  });

  it("fetchFileContent: raw at ref; 404 → null; traversal rejected", async () => {
    const { transport, calls } = fakeTransport(({ path }) => {
      if (path.includes("..")) throw new Error("must not reach transport");
      if (path.includes("missing.ts")) {
        throw new GitHubApiError(404, "Not Found");
      }
      return "file contents";
    });
    const provider = new GitHubProvider(transport);
    expect(await provider.fetchFileContent("octocat", "hello-world", "src/a.ts", "main")).toBe("file contents");
    expect(await provider.fetchFileContent("octocat", "hello-world", "missing.ts", "main")).toBeNull();
    await expect(provider.fetchFileContent("octocat", "hello-world", "../secrets", "main")).rejects.toMatchObject({
      status: 400,
    });
    expect(calls.every(c => !c.path.includes(".."))).toBe(true);
  });

  it("listBranches: marks the default branch", async () => {
    const { transport } = fakeTransport(({ path }) => {
      if (path === "/repos/octocat/hello-world") return REPO_FIXTURE; // default_branch: main
      return [{ name: "main", commit: { sha: "s1" } }, { name: "feature", commit: { sha: "s2" } }];
    });
    const provider = new GitHubProvider(transport);
    const branches = await drain(provider.listBranches("octocat", "hello-world"));
    expect(branches).toEqual([
      { name: "main", commitSha: "s1", isDefault: true },
      { name: "feature", commitSha: "s2", isDefault: false },
    ]);
  });

  it("listCommits and fetchCombinedCheckStatus map normalized shapes", async () => {
    const { transport } = fakeTransport(({ path }) => {
      if (path.includes("/status")) {
        return {
          state: "failure",
          statuses: [
            { context: "ci/build", state: "success", target_url: "https://ci/1" },
            { context: "ci/test", state: "error", target_url: null },
          ],
        };
      }
      return [
        { sha: "deadbeef", commit: { message: "fix", author: { name: "Alice", date: "2026-01-01" } }, html_url: "u" },
      ];
    });
    const provider = new GitHubProvider(transport);
    const commits = await provider.listCommits("octocat", "hello-world", { sha: "main", perPage: 10 });
    expect(commits[0]).toMatchObject({ sha: "deadbeef", message: "fix", author: "Alice" });
    const status = await provider.fetchCombinedCheckStatus("octocat", "hello-world", "abc");
    expect(status?.status).toBe("failing");
    expect(status?.checks[1]).toEqual({ name: "ci/test", state: "failure", url: null });
  });

  it("createCommit: ref → tree → commit → ref-update sequence", async () => {
    const { transport, calls } = fakeTransport(({ path, method }) => {
      if (path.endsWith("/git/ref/heads/fix") && method === "GET") return { object: { sha: "base1" } };
      if (path.endsWith("/git/commits/base1")) return { tree: { sha: "tre0" }, html_url: "c" };
      if (path.endsWith("/git/trees")) return { sha: "tre1" };
      if (path.endsWith("/git/commits") && method === "POST") return { sha: "c2", html_url: "https://c2" };
      if (path.endsWith("/git/refs/heads/fix") && method === "PATCH") return {};
      throw new Error(`unexpected ${method} ${path}`);
    });
    const provider = new GitHubProvider(transport);
    const result = await provider.createCommit("octocat", "hello-world", {
      branch: "fix",
      files: [{ path: "src/a.ts", content: "export {}" }],
      message: "apply fix",
    });
    expect(result).toEqual({ sha: "c2", url: "https://c2" });
    const postTree = calls.find(c => c.method === "POST" && c.path.endsWith("/git/trees"));
    expect(postTree?.body).toMatchObject({
      base_tree: "tre0",
      tree: [{ path: "src/a.ts", content: "export {}", mode: "100644", type: "blob" }],
    });
    const patchRef = calls.find(c => c.method === "PATCH");
    expect(patchRef?.body).toMatchObject({ sha: "c2" });
  });

  it("mergePullRequest: squash merge + temp fix-branch cleanup, keeps feature branches", async () => {
    const mergeBody = (headRef: string) => {
      const { transport, calls } = fakeTransport(({ path, method }) => {
        if (path.endsWith("/pulls/7") && method === "GET") return { ...PULL_FIXTURE, head: { ref: headRef } };
        if (path.endsWith("/merge")) return { merged: true, sha: "m1" };
        if (method === "DELETE") return {};
        throw new Error(`unexpected ${method} ${path}`);
      });
      return { transport, calls };
    };

    const tempBranch = mergeBody("auditpilot-fix-1");
    const providerTemp = new GitHubProvider(tempBranch.transport);
    const resTemp = await providerTemp.mergePullRequest("octocat", "hello-world", 7, { method: "squash" });
    expect(resTemp).toEqual({ merged: true, sha: "m1" });
    expect(tempBranch.calls.some(c => c.method === "DELETE" && c.path.includes("auditpilot-fix-1"))).toBe(true);

    const featureBranch = mergeBody("feature/xyz");
    const providerFeature = new GitHubProvider(featureBranch.transport);
    await providerFeature.mergePullRequest("octocat", "hello-world", 7, { method: "merge" });
    expect(featureBranch.calls.some(c => c.method === "DELETE")).toBe(false);
  });

  it("createPullRequest maps the summary", async () => {
    const { transport } = fakeTransport(({ body }) => {
      expect(body).toMatchObject({ head: "fix/login", base: "main", title: "Fix", draft: true });
      return PULL_FIXTURE;
    });
    const provider = new GitHubProvider(transport);
    const pr = await provider.createPullRequest("octocat", "hello-world", {
      sourceBranch: "fix/login",
      destinationBranch: "main",
      title: "Fix",
      draft: true,
    });
    expect(pr.number).toBe(7);
    expect(pr.state).toBe("open");
  });

  it("capability set matches the GitHub column of the capability matrix", () => {
    const { transport } = fakeTransport(() => []);
    const provider = new GitHubProvider(transport);
    expect(provider.capabilities.has("listPullRequests.allAuthors")).toBe(true);
    expect(provider.capabilities.has("listPullRequests.stateMerged")).toBe(true);
    expect(provider.capabilities.has("checks.status")).toBe(true);
    expect(provider.capabilities.has("commit.multiFile")).toBe(true);
  });
});
