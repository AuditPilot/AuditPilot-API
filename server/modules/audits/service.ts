import mongoose, { type Types } from "mongoose";
import { Audit, type AuditDocument } from "../../models/Audit";
import { AuditItem, type AuditItemDocument } from "../../models/AuditItem";
import { Report } from "../../models/Report";
import { GitHubClient, GitHubApiError } from "../../integrations/github/client";
import { runTask, untrustedDataBlock } from "../../integrations/ai/gateway";
import { logger } from "../../config/logger";
import { AppError } from "../../middleware/errorHandler";
import { assertOwnership } from "../../middleware/ownership";

const SOURCE_EXTENSIONS = [".js", ".ts", ".tsx", ".jsx", ".py", ".java", ".go", ".rb", ".php", ".cs", ".rs", ".cpp", ".c"];
const CONFIG_FILES = ["package.json", "tsconfig.json", "README.md", "requirements.txt", "Gemfile", "go.mod", "composer.json", "docker-compose.yml", "Dockerfile"];
const AUDIT_FILE_LIMIT = 8;
const FILE_CHAR_LIMIT = 3000;

// --- CRUD (thin wrappers; ownership filtering is enforced by callers) ---

export async function createAudit(data: Partial<AuditDocument>) {
  const newAudit = new Audit(data);
  return newAudit.save();
}

export async function getAuditWithItems(id: string) {
  const audit = await Audit.findById(id).lean();
  if (!audit) return undefined;
  const items = await AuditItem.find({ auditId: id }).lean();
  return { ...audit, items };
}

/**
 * Ownership-enforced audit fetch: a foreign OR untagged (legacy, unbackfilled)
 * audit is indistinguishable from a missing one (404 upstream).
 */
export async function findOwnAuditWithItems(id: string, userId: string) {
  const audit = await Audit.findOne({ _id: id, userId }).lean();
  if (!audit) return undefined;
  const items = await AuditItem.find({ auditId: audit._id }).lean();
  return { ...audit, items };
}

/**
 * Ownership gate for directly-addressed audit items.
 * New items carry their own `userId`; legacy items fall back to the ownership
 * of the parent audit. Any mismatch → 404 (existence not disclosed).
 */
export async function assertItemAccess(itemId: string, userId: string): Promise<AuditItemDocument> {
  const item = await AuditItem.findById(itemId).lean();
  if (!item) {
    throw AppError.notFound("Audit item not found");
  }
  const itemOwner = item.userId != null ? String(item.userId) : null;
  if (itemOwner === userId) {
    return item as AuditItemDocument;
  }
  if (itemOwner !== null) {
    throw AppError.notFound("Audit item not found");
  }
  const parent = await Audit.findById(item.auditId).lean();
  const parentOwner = parent?.userId != null ? String(parent.userId) : null;
  if (parentOwner !== userId) {
    throw AppError.notFound("Audit item not found");
  }
  return item as AuditItemDocument;
}

export async function listAudits(filter: Record<string, unknown> = {}) {
  return Audit.find(filter).sort({ createdAt: -1 }).lean();
}

export async function updateAudit(id: string, patch: Partial<AuditDocument>) {
  return Audit.findByIdAndUpdate(id, { ...patch, updatedAt: new Date() }, { new: true }).lean();
}

export async function deleteAudit(id: string) {
  await AuditItem.deleteMany({ auditId: id });
  await Report.deleteMany({ auditId: id });
  await Audit.findByIdAndDelete(id);
}

export async function createAuditItem(item: Partial<AuditItemDocument>) {
  const newItem = new AuditItem(item);
  return newItem.save();
}

export async function updateAuditItem(id: string, patch: Partial<AuditItemDocument>) {
  return AuditItem.findByIdAndUpdate(id, patch, { new: true }).lean();
}

export async function deleteAuditItem(id: string) {
  return AuditItem.findByIdAndDelete(id);
}

export async function findAuditItem(id: string) {
  return AuditItem.findById(id).lean();
}

// --- Repository deep audit --------------------------------------------------

interface RepoAuditInput {
  owner: string;
  repo: string;
  requestedBranch?: string;
  gh: GitHubClient;
  /** Owning user — stamped onto the audit and every item it produces. */
  userId: string;
  /**
   * Progress hook — the job worker passes one that funnels into the queue;
   * HTTP callers may omit it (migrated 1:1 from the legacy synchronous flow).
   */
  onProgress?: (snapshot: { stage: "fetching" | "analyzing" | "verifying"; percent: number; message?: string }) => void | Promise<void>;
}

interface AuditIssue {
  type?: string;
  severity?: string;
  description?: string;
  file?: string;
  fix?: { old_code?: string; new_code?: string };
  [k: string]: unknown;
}

async function resolveDefaultBranch(owner: string, repo: string, gh: GitHubClient): Promise<string> {
  const repoInfo = await gh.get<{ default_branch?: string }>(`/repos/${owner}/${repo}`);
  return repoInfo.default_branch || "main";
}

function selectAuditableFiles(paths: string[]): string[] {
  const isConfig = (p: string) => CONFIG_FILES.some(cfg => p.toLowerCase().endsWith(cfg));
  const isBadPath = (p: string) =>
    p.toLowerCase().includes("node_modules") ||
    p.toLowerCase().includes("dist") ||
    p.toLowerCase().includes("build") ||
    p.toLowerCase().includes(".git");
  const isSource = (p: string) =>
    SOURCE_EXTENSIONS.some(ext => p.toLowerCase().endsWith(ext)) && !isBadPath(p);
  const notBinary = (p: string) =>
    !/\.(png|jpg|jpeg|gif|pdf|zip|mp4|mp3|woff2?)$/i.test(p);

  const prioritized = paths.filter(p => (isConfig(p) || isSource(p)) && notBinary(p));
  const finalFiles = prioritized.length > 0 ? prioritized : paths.filter(notBinary);
  return finalFiles.slice(0, prioritized.length > 0 ? AUDIT_FILE_LIMIT : 5);
}

/** Paths whose lines should never be treated as auditable source. */
function isGeneratedPath(p: string): boolean {
  return /(^|\/)(node_modules|dist|build|\.git|vendor|target)(\/|$)/i.test(p);
}

/**
 * Resolves a (possibly sloppy) AI file hint to a REAL path in the repository
 * tree. AI models frequently answer with basenames, partial paths, or
 * placeholders like "Root" — this maps them back onto the actual tree:
 *   1. exact (case-insensitive) match
 *   2. same basename, ranked by longest shared path suffix
 *   3. token overlap (≥50% of the hint's meaningful tokens appear in the path)
 * Returns null when nothing plausible matches — callers must never invent a
 * fake path (the "Root" placeholder bug).
 */
export function resolveFilePath(hint: string | null | undefined, treePaths: string[]): string | null {
  if (!treePaths.length) return null;
  const clean = (hint ?? "").trim().replace(/^["'`]|["'`]$/g, "").replace(/\\/g, "/").replace(/^[./]+/, "");
  if (!clean || clean.length < 3) return null;

  const candidates = treePaths.filter(p => !isGeneratedPath(p));
  if (candidates.length === 0) return null;

  // 1) Exact (case-insensitive)
  const low = clean.toLowerCase();
  const exact = candidates.find(p => p.toLowerCase() === low);
  if (exact) return exact;

  // 2) Same basename — rank by longest shared suffix with the hint
  const base = low.split("/").pop() ?? low;
  const byBase = candidates.filter(p => {
    const pl = p.toLowerCase();
    return pl === base || pl.endsWith("/" + base) || pl.split("/").pop() === base;
  });
  if (byBase.length === 1) return byBase[0];
  if (byBase.length > 1) {
    const sharedSuffix = (p: string) => {
      const pl = p.toLowerCase();
      let n = 0;
      let i = pl.length - 1;
      let j = low.length - 1;
      while (i >= 0 && j >= 0 && pl[i] === low[j]) {
        n++;
        i--;
        j--;
      }
      return n;
    };
    return byBase.sort((a, b) => sharedSuffix(b) - sharedSuffix(a))[0];
  }

  // 3) Token overlap (e.g. hint "binance config" → "src/config/binance.js")
  const tokens = low.split(/[^\w.\-]+/).filter(t => t.length >= 3);
  if (!tokens.length) return null;
  // Boundary-aware containment: a placeholder like "root" must NOT match a
  // longer filename such as "RootScreen.tsx" (letters may not touch the token).
  const includesToken = (pl: string, token: string) =>
    new RegExp(`(^|[^a-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(pl);
  let best: { p: string; score: number } | null = null;
  for (const p of candidates) {
    const pl = p.toLowerCase();
    let score = 0;
    for (const t of tokens) if (includesToken(pl, t)) score++;
    if (score > 0 && (!best || score > best.score)) best = { p, score };
  }
  return best && best.score / tokens.length >= 0.5 ? best.p : null;
}

// --- Deterministic anchor recovery ------------------------------------------
// The AI frequently describes a finding WITHOUT file/code excerpts (it returns
// only label/type/severity). Instead of leaving those items unanchored, scan
// the file content we already fetched for strong tokens quoted in the finding
// label (e.g. 'menubtn') and recover: which file, which line, the snippet.

const ANCHOR_STOPWORDS = new Set([
  "unchecked", "reference", "referenced", "referencing", "before", "attaching", "attached", "onclick",
  "handler", "handlers", "element", "elements", "exist", "exists", "existing", "missing", "error",
  "errors", "uncaught", "referenceerror", "typeerror", "halt", "halts", "script", "scripts",
  "execution", "executing", "code", "this", "that", "with", "without", "will", "would", "should",
  "could", "does", "when", "while", "then", "there", "here", "only", "must", "also", "have", "has",
  "been", "from", "into", "same", "within", "inside", "outside", "every", "each", "which", "what",
  "security", "performance", "accessibility", "issue", "issues", "potential", "possibly", "undefined",
  "null", "empty", "page", "site", "website", "user", "users", "browser", "component", "function",
  "variable", "value", "content", "property", "props", "state", "text", "link", "image", "button",
  "input", "form", "list", "items", "screen", "screens", "using", "used", "usage", "files",
]);

export interface RecoveredAnchor {
  file: string;
  /** 1-based line of the best token hit. */
  line: number;
  /** Trimmed source line to keep as anchor evidence (`old_code`). */
  oldCode: string;
  score: number;
}

/**
 * Strong anchor tokens in order of confidence: quoted words first (`'menubtn'`),
 * then longer identifiers not in the stopword list.
 */
export function anchorTokens(label: string): Array<{ token: string; weight: number }> {
  const quoted = Array.from(label.matchAll(/[`'"]([^`'"@\n]{3,80})[`'"]/g))
    .map(m => m[1].trim())
    .filter(t => t.length >= 3);
  if (quoted.length > 0) {
    return Array.from(new Set(quoted.map(t => t.toLowerCase()))).map(token => ({ token, weight: 3 }));
  }
  const generic = Array.from(new Set(label.split(/[^A-Za-z0-9$.@/-]+/))).filter(
    t => t.length >= 5 && !ANCHOR_STOPWORDS.has(t.toLowerCase()) && /^[A-Za-z_$][\w$.@/-]*$/.test(t),
  );
  return generic.map(t => ({ token: t.toLowerCase(), weight: 1 }));
}

/**
 * Token-scan a set of file contents for the anchor tokens of one finding.
 * A hinted file gets a strong bias; files with token hits in their PATH get a
 * small one. Only confident hits pass the score threshold, so this never
 * fabricates anchors when the label has no code identifiers to look for.
 */
export function recoverAnchor(
  label: string,
  hintedFile: string | null,
  fileContents: Map<string, string>,
): RecoveredAnchor | null {
  const tokens = anchorTokens(label);
  if (!tokens.length) return null;

  let best: { file: string; line: number; score: number; codeLine: string } | null = null;
  for (const [path, content] of Array.from(fileContents)) {
    if (!content) continue;
    const lines = content.split("\n");
    const pathLow = path.toLowerCase();
    const fileBias = hintedFile === path ? 3 : tokens.some(({ token }) => pathLow.includes(token)) ? 1 : 0;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].toLowerCase();
      let score = fileBias;
      let hit = false;
      for (const { token, weight } of tokens) {
        if (l.includes(token)) {
          score += weight * (token.length >= 4 ? 2 : 1);
          hit = true;
        }
      }
      if (!hit) continue;
      if (!best || score > best.score) {
        best = { file: path, line: i + 1, score, codeLine: lines[i].trim() };
      }
    }
  }

  // Confidence floor: one quoted token hit (≥6) or two-or-more generic hits.
  const minScore = tokens.some(({ weight }) => weight >= 3) ? 6 : 3;
  if (!best || best.score < minScore) return null;
  return { file: best.file, line: best.line, oldCode: best.codeLine, score: best.score };
}

function normalizeIssues(rawIssues: unknown): AuditIssue[] {
  if (!Array.isArray(rawIssues)) return [];
  return rawIssues.map((issue: Record<string, unknown>) => {
    const oldCode = issue.old_code || issue.oldCode || ((issue.fix as Record<string, unknown>)?.old_code) || ((issue.fix as Record<string, unknown>)?.oldCode);
    const newCode = issue.new_code || issue.newCode || ((issue.fix as Record<string, unknown>)?.new_code) || ((issue.fix as Record<string, unknown>)?.newCode);
    const filePath = issue.file_path || issue.file || issue.path;
    const normalized: AuditIssue = {
      ...issue,
      file: filePath != null ? String(filePath) : undefined,
    };
    if (oldCode && newCode) {
      normalized.fix = { old_code: String(oldCode), new_code: String(newCode) };
    }
    return normalized;
  });
}

interface RepoAuditResult {
  audit: { _id: unknown; title: string; status: string; priority: string };
  issues: AuditIssue[];
  auditId: string;
  itemIds: string[];
  branch: string;
}

/** Runs the full repo audit synchronously (protected by user's plan check in the route). */
export async function runRepoAudit(input: RepoAuditInput): Promise<RepoAuditResult> {
  const { owner, repo, requestedBranch, gh, onProgress } = input;
  const ownerObjectId = new mongoose.Types.ObjectId(input.userId);

  // 1. Resolve target branch
  const targetBranch = requestedBranch || (await resolveDefaultBranch(owner, repo, gh));

  // 2. Fetch the full tree for that branch
  await onProgress?.({ stage: "fetching", percent: 15, message: `Fetching file tree (${targetBranch})…` });
  const treeData = await gh.get<{ tree: { type: string; path: string }[] }>(
    `/repos/${owner}/${repo}/git/trees/${targetBranch}?recursive=1`,
  );
  const allPaths = (treeData.tree || []).filter(f => f.type === "blob").map(f => f.path);
  const finalFiles = selectAuditableFiles(allPaths);

  if (finalFiles.length === 0) {
    throw AppError.badRequest("No suitable files found for analysis in this repository.");
  }

  logger.info(
    { owner, repo, branch: targetBranch, files: finalFiles.length },
    "selecting files for audit",
  );

  // 3. Fetch contents (truncated per file)
  const chunks: string[] = [];
  /** path → content actually shown to the AI — used to recover missing anchors. */
  const fileEvidence = new Map<string, string>();
  for (let i = 0; i < finalFiles.length; i++) {
    const path = finalFiles[i];
    try {
      const content = await gh.raw(`/repos/${owner}/${repo}/contents/${path}`);
      const truncated =
        content.length > FILE_CHAR_LIMIT
          ? `${content.substring(0, FILE_CHAR_LIMIT)}\n... [truncated]`
          : content;
      chunks.push(`\n--- File: ${path} ---\n${truncated}`);
      fileEvidence.set(path, truncated);
    } catch (err) {
      logger.warn({ path, err: (err as Error).message }, "skipped unreadable file during audit");
    }
    await onProgress?.({
      stage: "fetching",
      percent: 15 + Math.round(((i + 1) / finalFiles.length) * 30),
      message: `Reading repository files… (${i + 1}/${finalFiles.length})`,
    });
  }
  const repoContent = chunks.join("\n");
  if (repoContent.length === 0) {
    throw AppError.badRequest("No readable file content available for analysis in this repository.");
  }

  // 4. AI analysis — rereouted through the AI gateway (retries + zod gate +
  // cost tracking). Repository content is untrusted: wrapped in data markers.
  await onProgress?.({ stage: "analyzing", percent: 55, message: "Running AI analysis…" });
  const { data: parsed } = await runTask<{ issues?: unknown }>(
    "repo-audit",
    {
      system:
        "You are an expert security and performance auditor. Analyze the provided repository files and identify real issues. For EVERY issue you MUST output: (1) 'file' — the EXACT relative path copied VERBATIM from the '--- File: <path> ---' markers; never invent, shorten or placeholder it (NO 'Root'/'root'). (2) 'old_code' — a short verbatim excerpt (1–6 lines) copied EXACTLY as it appears in that file showing the problematic code; this is required even when you have no fix. (3) 'new_code' — the corrected code, ONLY when a concrete fix is available. Also provide type (security, performance, accessibility), severity (critical, medium, low), and description. Output valid JSON ONLY with an 'issues' array.",
      user: `REPOSITORY: ${owner}/${repo}\n\n${untrustedDataBlock(`FILES of ${owner}/${repo} @ ${targetBranch}`, repoContent)}\n\nAnalyze the file data above and provide the audit issues in the requested JSON format.`,
    },
    { userId: input.userId },
  );
  await onProgress?.({ stage: "verifying", percent: 80, message: "Verifying and persisting results…" });

  const issues = normalizeIssues(parsed?.issues ?? []);

  // Anchor recovery: the model sometimes emits findings with no file hint and
  // no code excerpts (label-only). The fetched-file evidence we already hold
  // lets us recover `file` + `old_code` deterministically — token-scanning the
  // content for quoted identifier(s) in the description (e.g. 'menubtn').
  for (const issue of issues) {
    const hinted = resolveFilePath(issue.file ? String(issue.file) : "", allPaths);
    const hasOldCode = Boolean(issue.fix?.old_code || (issue.old_code as unknown));
    if (hinted && hasOldCode) continue;
    const recovered = recoverAnchor(
      String(issue.description || ""),
      hinted ?? (issue.file ? String(issue.file) : null),
      fileEvidence,
    );
    if (!recovered) continue;
    if (!hasOldCode) (issue as { old_code?: string }).old_code = recovered.oldCode;
    if (!hinted) issue.file = recovered.file;
    logger.info(
      { owner, repo, recoveredFile: recovered.file, line: recovered.line, score: recovered.score },
      "recovered missing anchor for audit issue",
    );
  }

  // 5. Persist audit + items (owned by the requesting user)
  await onProgress?.({ stage: "verifying", percent: 90, message: "Saving audit results…" });
  const audit = await createAudit({
    userId: ownerObjectId,
    title: `Audit: ${repo}`,
    description: `Deep AI audit for ${owner}/${repo} using dynamic file discovery.`,
    status: "completed",
    priority: issues.some(i => i.severity === "critical") ? "critical" : "medium",
    scope: "Global Repository Scan",
    branch: targetBranch,
  });

  const itemIds: string[] = [];
  for (const issue of issues) {
    // Resolve the AI's file hint against the REAL tree we fetched — a bogus
    // hint ("Root", a bare basename, "config"…) must never be persisted as a
    // path, otherwise fix-preview fetches a non-existent file.
    const resolvedFile = resolveFilePath(issue.file ? String(issue.file) : "", allPaths);
    const item = await createAuditItem({
      auditId: audit._id,
      userId: ownerObjectId,
      label: String(issue.description || "Point of interest detected"),
      type: String(issue.type || "security"),
      value: resolvedFile ?? "",
      severity: (issue.severity as never) || "medium",
      old_code: issue.fix?.old_code || (issue.old_code as string),
      new_code: issue.fix?.new_code || (issue.new_code as string),
      complianceStatus: "non_compliant",
      auditorNotes: `Rank: ${issue.severity}. Recommendation: ${issue.new_code ? "Apply suggested fix" : "Manual review required"}`,
    });
    itemIds.push(String(item._id));
  }

  return {
    audit: audit as unknown as { _id: unknown; title: string; status: string; priority: string },
    issues,
    auditId: String(audit._id),
    itemIds,
    branch: targetBranch,
  };
}

// --- Fix application ------------------------------------------------------

export interface CodeLocation {
  /** Line number (1-based) of the first line of the matched snippet. */
  line: number;
  /** true when the file contains the snippet verbatim; false = whitespace-normalized match. */
  exact: boolean;
}

/**
 * Locates `oldCode` inside current file content: exact substring first, then
 * the same whitespace-flexible pattern applyReplacement uses. Returns null
 * when neither matches (the fix cannot be anchored to the live file).
 */
export function locateCode(content: string, oldCode: string): CodeLocation | null {
  if (!oldCode || !oldCode.trim()) return null;
  const exactIdx = content.indexOf(oldCode);
  if (exactIdx >= 0) {
    return { line: content.slice(0, exactIdx).split("\n").length, exact: true };
  }
  const escaped = oldCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  try {
    const regex = new RegExp(escaped);
    const match = regex.exec(content);
    if (match) {
      return { line: content.slice(0, match.index).split("\n").length, exact: false };
    }
  } catch {
    // malformed pattern — treat as not found
  }
  return null;
}

/** Whitespace-flexible single-replacing of old→new; returns null if no match. */
export function applyReplacement(currentContent: string, oldCode: string, newCode: string): string | null {
  if (currentContent.includes(oldCode)) {
    const next = currentContent.replace(oldCode, newCode);
    if (next !== currentContent) return next;
  }
  // normalized match
  const normalize = (s: string) => s.replace(/\r\n/g, "\n").trim();
  if (!normalize(currentContent).includes(normalize(oldCode))) return null;
  const escaped = oldCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  try {
    const regex = new RegExp(escaped, "g");
    const next = currentContent.replace(regex, newCode);
    return next !== currentContent ? next : null;
  } catch {
    return null;
  }
}

export async function checkBranchExists(owner: string, repo: string, ref: string, gh: GitHubClient): Promise<string> {
  const refData = await gh.get<{ object: { sha: string } }>(`/repos/${owner}/${repo}/git/ref/heads/${ref}`);
  return refData.object.sha;
}

/**
 * Derives the fix-branch suffix from a PR title so the branch itself is
 * descriptive (`auditpilot-fix-security-patch-for-voting` instead of
 * `auditpilot-fix-1772297270476`). Anything outside [a-z0-9] collapses to a
 * single dash; a title with no usable characters falls back to "fixes".
 */
export function slugifyBranchTitle(title: string): string {
  const slug = (title || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "fixes";
}

async function refExists(owner: string, repo: string, ref: string, gh: GitHubClient): Promise<boolean> {
  try {
    await checkBranchExists(owner, repo, ref, gh);
    return true;
  } catch (err) {
    // A genuine 404 means the ref is free; anything else is a real failure we
    // must not swallow (rate limits, network errors…).
    if (err instanceof GitHubApiError && err.status === 404) return false;
    throw err;
  }
}

/**
 * `auditpilot-fix-<slug(title)>` with collision handling — an already-existing
 * branch (e.g. the same title reused) gets `-2`, `-3`, … appended so branch
 * creation can never hard-fail on a duplicate name.
 */
export async function uniqueFixBranchName(owner: string, repo: string, prTitle: string, gh: GitHubClient): Promise<string> {
  const base = `auditpilot-fix-${slugifyBranchTitle(prTitle)}`;
  if (!(await refExists(owner, repo, base, gh))) return base;
  for (let n = 2; n <= 25; n++) {
    const candidate = `${base}-${n}`;
    if (!(await refExists(owner, repo, candidate, gh))) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export interface ApplyFixInput {
  owner: string;
  repo: string;
  targetBranch: string;
  issues: AuditIssue[];
  /** PR title — ALSO seeds the branch name (`auditpilot-fix-<slug(title)>`). */
  title?: string;
  /** PR description composed in the review UI; falls back to a stats summary. */
  description?: string;
  gh: GitHubClient;
}

export interface ApplyFixResult {
  prUrl: string;
  prNumber: number;
  branch: string;
  modifiedFiles: number;
}

export interface ApplyFixResult {
  prUrl: string;
  prNumber: number;
  branch: string;
  modifiedFiles: number;
  appliedIssues: number;
  /** Issues that could not be anchored to a file, with reasons. */
  skipped: Array<{ file: string; reason: string }>;
}

/** Bounded snapshot of current file content for the review UI. */
const MAX_PREVIEW_LINES = 1500;

export interface FixPreviewResult {
  auditId: string;
  /** Branch the preview (and the PR) is based on. */
  branch: string;
  /** path → bounded current content. */
  files: Record<string, { content: string; truncated: boolean; totalLines: number }>;
  items: Array<{
    itemId: string;
    label: string;
    type: string;
    severity: string;
    file: string | null;
    oldCode: string | null;
    newCode: string | null;
    /** null = snippet not found in the current file / file unreadable. */
    match: { line: number; exact: boolean } | null;
  }>;
}

/**
 * Builds per-item REAL current-code context for the fix-review UI — the UI
 * always shows the live file content, never the AI's stale quote. Each
 * unique file is fetched once; content is capped so big repositories don't
 * blow up the payload.
 */
export async function buildFixPreview(input: {
  owner: string;
  repo: string;
  auditId: string;
  targetBranch: string;
  items: Array<Record<string, unknown>>;
  gh: GitHubClient;
}): Promise<FixPreviewResult> {
  const { owner, repo, auditId, targetBranch, items, gh } = input;

  // Repo tree ONCE — used to validate/repair the AI's file hints so a bogus
  // hint ("Root", a bare basename…) never gets treated as a real path.
  let treePaths: string[] = [];
  try {
    const treeData = await gh.get<{ tree: { type: string; path: string }[] }>(
      `/repos/${owner}/${repo}/git/trees/${targetBranch}?recursive=1`,
    );
    treePaths = (treeData.tree || []).filter(f => f.type === "blob").map(f => f.path);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "fix preview: tree fetch failed — hints used unvalidated");
  }

  const fileToPath = (item: Record<string, unknown>): string | null => {
    const raw =
      (typeof item.value === "string" ? item.value.trim() : "") ||
      (typeof item.file === "string" ? item.file.trim() : "");
    const resolved = resolveFilePath(raw, treePaths);
    if (resolved) return resolved;
    // No tree available (fetch failed): accept a hint only when it already
    // looks like a real path — never a placeholder like "Root".
    const looksLikePath = /^[.\w\-/]+\.[A-Za-z0-9]{1,8}$/.test(raw.replace(/\\/g, "/").replace(/^[./]+/, ""));
    if (!treePaths.length && raw.length > 2 && !/^root$/i.test(raw) && looksLikePath) {
      return raw.replace(/\\/g, "/").replace(/^[./]+/, "");
    }
    return null;
  };

  // Unique RESOLVED file paths across all items
  const paths = Array.from(new Set(items.map(fileToPath).filter((p): p is string => !!p)));

  // Fetch each referenced file once
  const contents = new Map<string, string>();
  for (const p of paths) {
    try {
      const fileData = await gh.get<{ content: string }>(
        `/repos/${owner}/${repo}/contents/${p}?ref=${encodeURIComponent(targetBranch)}`,
      );
      contents.set(p, Buffer.from(fileData.content, "base64").toString("utf-8"));
    } catch {
      // unreadable file — item renders with match: null (no usable anchor)
      contents.set(p, "");
    }
  }

  const files: FixPreviewResult["files"] = {};
  for (const [p, content] of Array.from(contents.entries())) {
    if (!content) continue; // a path that 404'd must not appear as an empty file entry
    const normalized = content.replace(/\r\n/g, "\n");
    const totalLines = normalized.split("\n").length;
    const lines = normalized.split("\n");
    files[p] = {
      content: lines.slice(0, MAX_PREVIEW_LINES).join("\n"),
      truncated: totalLines > MAX_PREVIEW_LINES,
      totalLines,
    };
  }

  return {
    auditId,
    branch: targetBranch,
    files,
    items: items.map(item => {
      const filePath = fileToPath(item);
      const label = typeof item.label === "string" ? item.label : "Issue";
      const oldCode = typeof item.old_code === "string" ? item.old_code : null;
      const newCode = typeof item.new_code === "string" ? item.new_code : null;
      const content = filePath ? contents.get(filePath) ?? "" : "";
      let match = oldCode ? locateCode(content, oldCode) : null;
      let anchoredOldCode = oldCode;

      // Recovery at query time: items that never got code anchors (label-only
      // AI output) are token-scanned against the content we just fetched so
      // the edit view can pin a real line. Never fabricate: recovery returns
      // null when the label has no code-searchable tokens.
      if ((!match || !anchoredOldCode) && filePath && content) {
        const recovered = recoverAnchor(label, filePath, new Map([[filePath, content]]));
        if (recovered) {
          if (!anchoredOldCode) anchoredOldCode = recovered.oldCode;
          match = { line: recovered.line, exact: false };
        }
      }

      return {
        itemId: String(item._id),
        label,
        type: typeof item.type === "string" ? item.type : "issue",
        severity: typeof item.severity === "string" ? item.severity : "medium",
        file: filePath,
        oldCode: anchoredOldCode,
        newCode,
        match,
      };
    }),
  };
}

export async function applyFixesAndCreatePR(input: ApplyFixInput): Promise<ApplyFixResult> {
  const { owner, repo, targetBranch, issues, title, description, gh } = input;

  const baseSha = await checkBranchExists(owner, repo, targetBranch, gh);

  // Branch is named AFTER the PR title so every GitHub side-tab is readable
  // (`auditpilot-fix-<slug(title)>` instead of a timestamp).
  const prTitle = title?.trim() || "AuditPilot: Fix security and performance issues";
  const newBranchName = await uniqueFixBranchName(owner, repo, prTitle, gh);
  await gh.post(`/repos/${owner}/${repo}/git/refs`, {
    ref: `refs/heads/${newBranchName}`,
    sha: baseSha,
  });

  // Group issues by file: read each file ONCE, apply all its substitutions
  // cumulatively, then make a SINGLE commit per changed file (instead of one
  // commit per issue).
  const perFile = new Map<string, { content: string; sha: string }>();
  const changed = new Set<string>();
  const skipped: Array<{ file: string; reason: string }> = [];

  for (const issue of issues) {
    const oldCode = issue.fix?.old_code || (issue.old_code as string);
    const newCode = issue.fix?.new_code || (issue.new_code as string);
    const filePath =
      (issue.file as string) || (issue.file_path as string) || (issue.path as string) || (issue.value as string);
    if (!oldCode || !newCode || !filePath) {
      skipped.push({ file: filePath || "?", reason: "incomplete fix data — missing old/new code or file path" });
      continue;
    }

    let ctx = perFile.get(filePath);
    if (!ctx) {
      try {
        const fileData = await gh.get<{ content: string; sha: string }>(
          `/repos/${owner}/${repo}/contents/${filePath}?ref=${newBranchName}`,
        );
        ctx = {
          content: Buffer.from(fileData.content, "base64").toString("utf-8"),
          sha: fileData.sha,
        };
        perFile.set(filePath, ctx);
      } catch {
        skipped.push({ file: filePath, reason: "file not found on the target branch" });
        continue;
      }
    }

    const next = applyReplacement(ctx.content, oldCode, newCode);
    if (!next) {
      skipped.push({
        file: filePath,
        reason: "the issue's quoted code no longer matches the current file (version or whitespace drift)",
      });
      continue;
    }
    ctx.content = next;
    changed.add(filePath);
  }

  let modifiedFilesCount = 0;
  for (const filePath of Array.from(changed)) {
    const ctx = perFile.get(filePath)!;
    try {
      await gh.put(`/repos/${owner}/${repo}/contents/${filePath}`, {
        message: `AuditPilot: apply fixes in ${filePath}`,
        content: Buffer.from(ctx.content).toString("base64"),
        sha: ctx.sha,
        branch: newBranchName,
      });
      modifiedFilesCount++;
    } catch (err) {
      skipped.push({ file: filePath, reason: `commit failed: ${(err as Error).message}` });
    }
  }

  const appliedIssues = issues.length - skipped.length;
  if (modifiedFilesCount === 0) {
    throw AppError.badRequest(
      "No changes could be applied — none of the issue snippets matched the current files. Review and edit the fixes, or refresh the preview (the repository may have moved on).",
      skipped,
    );
  }

  const stats = [
    `**Applied:** ${appliedIssues} issue(s) across ${modifiedFilesCount} file(s)`,
    ...(skipped.length
      ? ["", `**Skipped (${skipped.length}):**`, ...skipped.slice(0, 15).map(s => `- \`${s.file}\` — ${s.reason}`)]
      : []),
  ];
  const createdPR = await gh.post<{ html_url: string; number: number }>(`/repos/${owner}/${repo}/pulls`, {
    title: prTitle,
    body: [
      description?.trim() || "This PR applies automated fixes for issues identified during the AI audit.",
      "",
      "---",
      "",
      ...stats,
    ].join("\n"),
    head: newBranchName,
    base: targetBranch,
  });

  return {
    prUrl: createdPR.html_url,
    prNumber: createdPR.number,
    branch: newBranchName,
    modifiedFiles: modifiedFilesCount,
    appliedIssues,
    skipped,
  };
}

export interface ApplyContentsInput {
  owner: string;
  repo: string;
  targetBranch: string;
  /** path → FULL new file content (UTF-8) produced by the review/edit UI. */
  files: Record<string, string>;
  /** PR title — ALSO seeds the branch name (`auditpilot-fix-<slug(title)>`). */
  title?: string;
  /** PR description composed in the review UI; falls back to a stats summary. */
  description?: string;
  gh: GitHubClient;
}

/**
 * Commits user-reviewed FULL file contents to a fresh branch and opens a PR.
 * Unlike applyFixesAndCreatePR (old→new snippet substitution), this accepts
 * whole files exactly as the user left them in the edit UI — insertions,
 * deletions and rewrites are all preserved verbatim.
 */
export async function applyEditedContentsAndCreatePR(input: ApplyContentsInput): Promise<ApplyFixResult> {
  const { owner, repo, targetBranch, files, title, description, gh } = input;

  const entries = Object.entries(files).filter(([path]) => path && typeof files[path] === "string");
  if (entries.length === 0) {
    throw AppError.badRequest("files (path → content) must contain at least one edited file");
  }

  const baseSha = await checkBranchExists(owner, repo, targetBranch, gh);

  // Branch is named AFTER the PR title so it is identifiable at a glance
  // (`auditpilot-fix-<slug(title)>` instead of `auditpilot-fix-<timestamp>`).
  const prTitle = title?.trim() || "AuditPilot: Apply reviewed code fixes";
  const newBranchName = await uniqueFixBranchName(owner, repo, prTitle, gh);
  await gh.post(`/repos/${owner}/${repo}/git/refs`, {
    ref: `refs/heads/${newBranchName}`,
    sha: baseSha,
  });

  const skipped: Array<{ file: string; reason: string }> = [];
  let committed = 0;
  for (const [filePath, content] of entries) {
    try {
      const fileData = await gh.get<{ sha: string }>(
        `/repos/${owner}/${repo}/contents/${filePath}?ref=${newBranchName}`,
      );
      await gh.put(`/repos/${owner}/${repo}/contents/${filePath}`, {
        message: `AuditPilot: apply reviewed edits in ${filePath}`,
        content: Buffer.from(content).toString("base64"),
        sha: fileData.sha,
        branch: newBranchName,
      });
      committed++;
    } catch (err) {
      skipped.push({ file: filePath, reason: `commit failed: ${(err as Error).message}` });
    }
  }

  if (committed === 0) {
    throw AppError.badRequest(
      "No edited files could be committed to the fix branch.",
      skipped,
    );
  }

  const stats = [
    `**Updated:** ${committed} file(s)`,
    ...(skipped.length
      ? ["", `**Skipped (${skipped.length}):**`, ...skipped.slice(0, 15).map(s => `- \`${s.file}\` — ${s.reason}`)]
      : []),
  ];
  const createdPR = await gh.post<{ html_url: string; number: number }>(`/repos/${owner}/${repo}/pulls`, {
    title: prTitle,
    body: [
      description?.trim() || "This PR applies code fixes reviewed and edited in AuditPilot.",
      "",
      "---",
      "",
      ...stats,
    ].join("\n"),
    head: newBranchName,
    base: targetBranch,
  });

  return {
    prUrl: createdPR.html_url,
    prNumber: createdPR.number,
    branch: newBranchName,
    modifiedFiles: committed,
    appliedIssues: committed,
    skipped,
  };
}
