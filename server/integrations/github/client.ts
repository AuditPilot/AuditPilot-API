import { logger } from "../../config/logger";

/**
 * GitHub REST client wrapper.
 *
 * Centralizes: auth headers, User-Agent, timeouts, retry with backoff, and
 * secondary-rate-limit handling. Services build a client per request from the
 * user's decrypted token (or an installation token in a later step).
 */

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 3;
const USER_AGENT = "Audit-Pilot-App";

export type GitHubToken = string;

interface RequestOpts {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Return raw text (for `Accept: application/vnd.github.v3.raw`). */
  raw?: boolean;
  timeoutMs?: number;
}

function isRetriable(status: number): boolean {
  return status === 500 || status === 502 || status === 503 || status === 504;
}

export class GitHubApiError extends Error {
  readonly status: number;
  readonly data: unknown;
  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    this.data = data;
  }
}

export class GitHubClient {
  constructor(private readonly token: GitHubToken) {}

  async request<T = unknown>(path: string, opts: RequestOpts = {}): Promise<T> {
    const { method = "GET", body, raw = false, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const url = path.startsWith("http") ? path : `https://api.github.com${path}`;
        const res = await fetch(url, {
          method,
          headers: {
            Authorization: `token ${this.token}`,
            Accept: raw ? "application/vnd.github.v3.raw" : "application/vnd.github.v3+json",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });

        // 403/429 with rate-limit headers: wait for the reset window
        if (res.status === 403 || res.status === 429) {
          const remaining = res.headers.get("x-ratelimit-remaining");
          const resetHeader = res.headers.get("x-ratelimit-reset");
          if (remaining === "0" && resetHeader) {
            const resetEpochSec = Number(resetHeader);
            const waitMs = Math.min(Math.max((resetEpochSec * 1000 - Date.now()) + 1000, 1000), 60_000);
            logger.warn({ waitMs, path }, "GitHub rate limit hit — waiting for reset");
            await new Promise(r => setTimeout(r, waitMs));
            lastError = new GitHubApiError(res.status, "GitHub secondary/rate limit");
            continue;
          }
        }

        if (res.ok) {
          if (res.status === 204) return undefined as T;
          return (raw ? await res.text() : await res.json()) as T;
        }

        const errText = await res.text().catch(() => "");
        let errData: unknown = errText;
        try {
          errData = JSON.parse(errText);
        } catch {
          /* keep text */
        }
        const message =
          (errData as { message?: string })?.message || `GitHub request failed (${res.status})`;

        if (isRetriable(res.status) && attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 500 * attempt));
          lastError = new GitHubApiError(res.status, message, errData);
          continue;
        }

        throw new GitHubApiError(res.status, message, errData);
      } catch (err) {
        lastError = err as Error;
        const retriable = (err as { name?: string }).name === "TimeoutError" || isRetriable((err as { status?: number }).status ?? 0);
        if (retriable && attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 500 * attempt));
          continue;
        }
        if (!retriable) throw err;
      }
    }

    throw lastError ?? new GitHubApiError(500, "GitHub request failed");
  }

  get<T = unknown>(path: string, opts?: Omit<RequestOpts, "method" | "body">) {
    return this.request<T>(path, opts);
  }
  post<T = unknown>(path: string, body: unknown) {
    return this.request<T>(path, { method: "POST", body });
  }
  put<T = unknown>(path: string, body?: unknown) {
    return this.request<T>(path, { method: "PUT", body });
  }
  patch<T = unknown>(path: string, body: unknown) {
    return this.request<T>(path, { method: "PATCH", body });
  }
  del<T = unknown>(path: string) {
    return this.request<T>(path, { method: "DELETE" });
  }
  raw(path: string) {
    return this.request<string>(path, { raw: true });
  }
}

export function githubClientFromToken(token: string | null | undefined): GitHubClient {
  if (!token) {
    // Fail fast with a clear error instead of sending an anonymous request.
    throw new GitHubApiError(401, "No valid GitHub token available. Please re-authenticate.");
  }
  return new GitHubClient(token);
}
