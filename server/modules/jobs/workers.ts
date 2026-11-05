import { githubTokenForUser } from "../auth/service";
import { runRepoAudit } from "../audits/service";
import { reviewPullRequest } from "../reviews/service";
import { generateInsightsReport } from "../reports/service";
import { githubClientFromToken } from "../../integrations/github/client";
import { AppError } from "../../middleware/errorHandler";
import { logger } from "../../config/logger";
import { release, type UsageAction } from "../usage/service";
import { mongoQueue, type JobQueueAdapter } from "./queue";
import type { JobDocument, JobType } from "./model";

/**
 * Background workers for the Mongo-backed queue.
 *
 * One in-process poll loop claims jobs through the ATOMIC queue.claimNext()
 * (safe against concurrent processes), dispatches to the per-type handler,
 * streams progress into the queue, and applies the retry policy on failure.
 *
 * Deploy notes:
 * - WEB + worker in one process is the default (small deployments).
 * - DISABLE_WORKERS=1 → API-only process (dedicated worker process).
 * - WORKER_ONLY=1 is honored by index.ts (no HTTP listener; workers only).
 * In-memory crash recovery: a claimed job leases for LEASE_MS; if the worker
 * dies mid-run the expired lease makes the job claimable again on another
 * process. (See queue.ts for exact semantics.)
 */

const POLL_MS = 1000;

interface ClaimableJob {
  _id: JobDocument["_id"];
  type: JobType;
  userId: JobDocument["userId"];
  payload: JobDocument["payload"];
  attempts: number;
}

type Handler = (job: ClaimableJob, deps: WorkerDeps) => Promise<unknown>;

interface WorkerDeps {
  queue: JobQueueAdapter;
}

function payloadAs<T extends Record<string, unknown>>(payload: Record<string, unknown>): T {
  return payload as T;
}

/** Resolves a decryptable GitHub token for the job owner or throws. */
async function requireGithubToken(userId: string): Promise<string> {
  const token = await githubTokenForUser(userId);
  if (!token) {
    throw AppError.unauthorized("No GitHub token on record for this user — reconnect GitHub access.");
  }
  return token;
}

/** Which usage reservation each job type consumed (null = not counted). */
const USAGE_ACTION_BY_JOB: Record<JobType, UsageAction | null> = {
  "repo-audit": "audit",
  "pr-review": "pr-review",
  "report-insights": null,
};

// NOTE: usage is RESERVED at route/enqueue time (server/modules/usage) — the
// workers never increment. Their only finance duty is the REFUND below:
// a job that permanently fails releases its reservation.
const HANDLERS: Record<JobType, Handler> = {
  "repo-audit": async (job, deps) => {
    const { owner, repo, requestedBranch } = payloadAs<{ owner: string; repo: string; requestedBranch?: string }>(job.payload);
    const userId = String(job.userId);
    const token = await requireGithubToken(userId);
    const gh = githubClientFromToken(token);

    const result = await runRepoAudit({
      owner,
      repo,
      requestedBranch,
      gh,
      userId,
      onProgress: snapshot => deps.queue.setProgress(job._id, snapshot),
    });

    return {
      auditId: result.auditId,
      branch: result.branch,
      issuesCount: result.issues.length,
    };
  },

  "pr-review": async (job, deps) => {
    const { owner, repo, number } = payloadAs<{ owner: string; repo: string; number: string }>(job.payload);
    const userId = String(job.userId);
    await deps.queue.setProgress(job._id, {
      stage: "analyzing",
      percent: 40,
      message: `Reviewing changes for PR #${number}…`,
    });
    const token = await requireGithubToken(userId);
    const gh = githubClientFromToken(token);

    const issues = await reviewPullRequest({ owner, repo, number, gh, userId, jobId: String(job._id) });

    return { issues, count: issues.length };
  },

  "report-insights": async (job, deps) => {
    const { auditId } = payloadAs<{ auditId?: string }>(job.payload);
    const userId = String(job.userId);
    await deps.queue.setProgress(job._id, {
      stage: "analyzing",
      percent: 40,
      message: "Generating AI insights…",
    });
    if (!auditId) {
      throw AppError.badRequest("report-insights job missing auditId payload");
    }
    const report = await generateInsightsReport({ auditId, userId });
    return {
      reportId: String(report._id),
      riskScore: report.riskScore ?? null,
    };
  },
};

let workerRunning = false;

/**
 * Starts the single in-process worker loop. Returns null when one is already
 * running in this process; the handle allows stop() in tests / shutdown.
 */
export function startWorkers(deps: WorkerDeps = { queue: mongoQueue }) {
  if (workerRunning) {
    logger.warn("worker loop already running in this process — ignored");
    return null;
  }
  workerRunning = true;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const job = await deps.queue.claimNext();
      if (job) {
        const claimable = job as unknown as ClaimableJob;
        logger.info(
          { jobId: String(claimable._id), type: claimable.type, attempts: claimable.attempts },
          "job claimed",
        );
        await processJob(claimable, deps);
        // Drain the queue immediately if more work is waiting.
        timer = setTimeout(() => void tick(), 0);
        return;
      }
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "worker loop error",
      );
    }
    timer = setTimeout(() => void tick(), POLL_MS);
  };

  void tick();
  logger.info("job workers started");

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      workerRunning = false;
      logger.info("job workers stopped");
    },
  };
}

async function processJob(job: ClaimableJob, deps: WorkerDeps): Promise<void> {
  const handler = HANDLERS[job.type];
  if (!handler) {
    await deps.queue.fail(job._id, `No handler for job type ${job.type}`, 0 /* permanently fail */);
    return;
  }
  try {
    const result = await handler(job, deps);
    await deps.queue.complete(job._id, result);
    logger.info({ jobId: String(job._id), type: job.type }, "job completed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const updated = await deps.queue.fail(job._id, message);
    if (updated && updated.state === "failed") {
      logger.error({ jobId: String(job._id), type: job.type, err: message }, "job permanently failed");
      // Refund the reservation — permanently failed work never consumes quota.
      const action = USAGE_ACTION_BY_JOB[job.type];
      if (action) {
        await release(job.userId, action);
      }
    } else {
      logger.warn(
        { jobId: String(job._id), type: job.type, err: message, attempt: job.attempts, retryAt: updated?.runAt },
        "job failed — requeued with backoff",
      );
    }
  }
}
