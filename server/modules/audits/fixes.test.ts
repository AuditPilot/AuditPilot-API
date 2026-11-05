import { describe, expect, it } from "vitest";
import { AppError } from "../../middleware/errorHandler";
import {
  applyFixesAndCreatePR,
  locateCode,
  type ApplyFixInput,
} from "./service";

// --- locateCode -------------------------------------------------------------

describe("locateCode", () => {
  it("returns the exact first occurrence with its 1-based line", () => {
    const content = "line1\n  const x = 1;\nline3";
    const loc = locateCode(content, "const x = 1;");
    expect(loc).toEqual({ line: 2, exact: true });
  });

  it("matches with whitespace flexibility when the exact snippet drifted", () => {
    const content = "foo();\r\nif (a) {\r\n    bar();\r\n}";
    // AI quoted LF + different indentation
    const loc = locateCode(content, "if (a) {\n  bar();\n}");
    expect(loc).toBeTruthy();
    expect(loc!.exact).toBe(false);
    expect(loc!.line).toBe(2);
  });

  it("returns null when the snippet cannot be anchored", () => {
    expect(locateCode("dtimp functionally different", "export function gone() {}")).toBeNull();
    expect(locateCode("something", "  ")).toBeNull(); // blank snippet
  });
});

// --- applyFixesAndCreatePR ---------------------------------------------------

function fakeGh(files: Record<string, string>, failPutsFor: string[] = []) {
  const baseSha = "base123";
  const calls: { puts: Array<{ path: string; content: string }>; prs: Array<{ head: string }> } = {
    puts: [],
    prs: [],
  };
  const gh = {
    get: async (url: string) => {
      if (url.includes("/git/ref/heads/")) return { object: { sha: baseSha } };
      const rest = url.split("/contents/")[1] ?? "";
      const p = decodeURIComponent(rest.split("?ref=")[0]);
      if (!(p in files)) throw new Error(`404 ${p}`);
      return { content: Buffer.from(files[p]).toString("base64"), sha: `sha-${p}` };
    },
    put: async (url: string, body: { content: string }) => {
      const p = decodeURIComponent(url.split("/contents/")[1]);
      if (failPutsFor.includes(p)) throw new Error("cannot push to protected branch");
      calls.puts.push({ path: p, content: Buffer.from(body.content, "base64").toString("utf-8") });
      return {};
    },
    post: async (url: string, body: { ref?: string; head?: string }) => {
      if (url.endsWith("/git/refs")) return {};
      calls.prs.push({ head: body.head ?? "" });
      return { html_url: "https://github.com/o/r/pull/7", number: 7 };
    },
  };
  return { gh, calls };
}

function fixInput(gh: unknown, issues: Record<string, unknown>[]): ApplyFixInput {
  return {
    owner: "o",
    repo: "r",
    targetBranch: "main",
    issues: issues as never[],
    gh: gh as ApplyFixInput["gh"],
  };
}

describe("applyFixesAndCreatePR", () => {
  it("batches multiple fixes in the same file into ONE commit per file", async () => {
    const { gh, calls } = fakeGh({ "src/x.ts": "alpha\nmiddle\nomega" });

    const result = await applyFixesAndCreatePR(fixInput(gh, [
      { file: "src/x.ts", old_code: "alpha", new_code: "BRAVO" },
      { file_path: "src/x.ts", old_code: "omega", new_code: "ZULU" },
    ]));

    expect(calls.puts).toHaveLength(1); // one file → one commit
    expect(calls.puts[0].content).toBe("BRAVO\nmiddle\nZULU");
    expect(calls.prs[0].head.startsWith("auditpilot-fix-")).toBe(true);
    expect(result.prNumber).toBe(7);
    expect(result.appliedIssues).toBe(2);
    expect(result.modifiedFiles).toBe(1);
    expect(result.skipped).toEqual([]);
  });

  it("still creates the PR for partial success and reports skipped reasons", async () => {
    const { gh, calls } = fakeGh({ "src/x.ts": "current code" });

    const result = await applyFixesAndCreatePR(fixInput(gh, [
      { file: "src/x.ts", old_code: "current", new_code: "changed" },
      { file: "src/x.ts", old_code: "long gone from the file", new_code: "whatever" },
      { file_path: "", old_code: "a", new_code: "b" }, // missing path
    ]));

    expect(result.appliedIssues).toBe(1);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0].reason).toContain("no longer matches");
    expect(result.skipped[1].reason).toContain("incomplete fix data");
    // PR was still created
    expect(calls.prs).toHaveLength(1);
  });

  it("fails with 400 + per-file reasons when NOTHING applies", async () => {
    const { gh, calls } = fakeGh({ "src/x.ts": "current code" });

    await expect(
      applyFixesAndCreatePR(fixInput(gh, [
        { file: "src/x.ts", old_code: "no such snippet", new_code: "x" },
      ])),
    ).rejects.toSatisfy(err => err instanceof AppError && err.status === 400);
    // no PR, no commits
    expect(calls.prs).toHaveLength(0);
    expect(calls.puts).toHaveLength(0);
  });
});
