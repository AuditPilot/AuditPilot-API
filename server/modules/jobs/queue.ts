import mongoose, { type UpdateQuery, type QueryFilter } from "mongoose";
import { Job, type JobDocument, type JobStage, type JobType } from "./model";

/**
 * Mongo-backed queue interface.
 *
 * Deliberately behind an adapter interface so a BullMQ/Redis swap later only
 * replaces this module — callers depend on these functions, not Mongo.
 *
 * Claim semantics (the load-bearing part):
 * - `claimNext` is an ATOMIC findOneAndUpdate — two processes scanning
 *   concurrently can never be handed the same fresh job, because the first
 *   updater mutates the very fields the filter matches on.
 * - `leaseUntil` covers crash recovery: a worker that dies mid-run leaves
 *   the job "running"; once the lease expires it becomes claimable again
 *   (attempts keeps counting).
 */
export const LEASE_MS = 15 * 60 * 1000;
/** Exponential backoff for failed jobs: runAt = now + RETRY_BASE_MS * 2^(attempts-1). */
export const RETRY_BASE_MS = 30 * 1000;

export interface EnqueueInput {
  type: JobType;
  userId: string | unknown;
  payload: Record<string, unknown>;
  runAt?: Date;
  maxAttempts?: number;
}

export async function enqueue(input: EnqueueInput): Promise<JobDocument> {
  // Normalize + validate the owner id here (throws on a malformed id).
  const ownerId = new mongoose.Types.ObjectId(String(input.userId));
  return Job.create({
    type: input.type,
    userId: ownerId,
    payload: input.payload,
    runAt: input.runAt ?? new Date(),
    maxAttempts: input.maxAttempts ?? 3,
    state: "queued",
    stage: "queued",
    percent: 0,
    attempts: 0,
  } as unknown as Parameters<typeof Job.create>[0]);
}

/**
 * Atomically claims the next claimable job (queued and due, OR running but
 * with an expired lease). FIFO by scheduled time.
 */
export async function claimNext(type?: JobType): Promise<JobDocument | null> {
  const now = new Date();
  const filter: QueryFilter<JobDocument> = {
    ...(type ? { type } : {}),
    $or: [
      { state: "queued", runAt: { $lte: now } },
      { state: "running", leaseUntil: { $lt: now } },
    ],
  };
  const update: UpdateQuery<JobDocument> = {
    $set: {
      state: "running",
      stage: "fetching" as JobStage,
      leaseUntil: new Date(Date.now() + LEASE_MS),
      startedAt: now,
      percent: 0,
    },
    $inc: { attempts: 1 },
    $unset: {
      error: 1,
      message: 1,
      finishedAt: 1,
    },
  };
  // Atomic claim across processes: the first findOneAndUpdate flips the
  // state, so subsequent scans no longer match the filter.
  return Job.findOneAndUpdate(filter, update, {
    sort: { runAt: 1 },
    returnDocument: "after",
    lean: true,
  }) as unknown as Promise<JobDocument | null>;
}

export interface ProgressInput {
  stage?: JobStage;
  percent?: number;
  message?: string;
}

/** Live progress from a worker; also renews the lease so long AI calls survive. */
export async function setProgress(jobId: string | unknown, progress: ProgressInput): Promise<void> {
  const fields: Partial<Pick<JobDocument, "leaseUntil" | "stage" | "percent" | "message">> = {
    leaseUntil: new Date(Date.now() + LEASE_MS),
  };
  if (progress.stage !== undefined) fields.stage = progress.stage;
  if (progress.percent !== undefined) fields.percent = progress.percent;
  if (progress.message !== undefined) fields.message = progress.message;
  await Job.updateOne(
    { _id: jobId as unknown as JobDocument["_id"], state: "running" },
    { $set: fields },
  );
}

export async function complete(jobId: string | unknown, result: unknown): Promise<JobDocument | null> {
  return Job.findByIdAndUpdate(
    jobId,
    {
      $set: {
        state: "done",
        stage: "posting",
        percent: 100,
        result,
        leaseUntil: undefined,
        finishedAt: new Date(),
      },
    },
    { returnDocument: "after", lean: true },
  );
}

/**
 * Marks failure. If the job still has attempts left, it is re-queued with
 * exponential backoff. `attempts` is compared AFTER the running attempt —
 * attempts=2 means 2 of maxAttempts runs were already consumed.
 */
export async function fail(
  jobId: string | unknown,
  error: unknown,
  preferredMaxAttempts?: number,
): Promise<JobDocument | null> {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
  const job = await Job.findById(jobId, null, { lean: true });
  if (!job) return null;
  const maxAttempts = preferredMaxAttempts ?? job.maxAttempts;
  if (job.attempts >= maxAttempts) {
    return Job.findByIdAndUpdate(
      job._id,
      {
        $set: {
          state: "failed",
          error: { message },
          leaseUntil: undefined,
          finishedAt: new Date(),
        },
      },
      { returnDocument: "after", lean: true },
    );
  }
  const delay = RETRY_BASE_MS * Math.pow(2, job.attempts - 1);
  return Job.findByIdAndUpdate(
    job._id,
    {
      $set: {
        state: "queued",
        stage: "queued",
        percent: 0,
        error: { message },
        runAt: new Date(Date.now() + delay),
        leaseUntil: undefined,
      },
    },
    { returnDocument: "after", lean: true },
  );
}

export async function getById(jobId: string | unknown): Promise<JobDocument | null> {
  return Job.findById(jobId, null, { lean: true });
}

/**
 * The queue contract — swap today's Mongo implementation for BullMQ by
 * re-exporting an adapter with the same shape.
 */
export interface JobQueueAdapter {
  enqueue(input: EnqueueInput): Promise<JobDocument>;
  claimNext(type?: JobType): Promise<JobDocument | null>;
  setProgress(jobId: string | unknown, progress: ProgressInput): Promise<void>;
  complete(jobId: string | unknown, result: unknown): Promise<JobDocument | null>;
  fail(jobId: string | unknown, error: unknown, maxAttempts?: number): Promise<JobDocument | null>;
  getById(jobId: string | unknown): Promise<JobDocument | null>;
}

export const mongoQueue: JobQueueAdapter = {
  enqueue,
  claimNext,
  setProgress,
  complete,
  fail,
  getById,
};
