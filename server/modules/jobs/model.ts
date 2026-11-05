import mongoose, { type Document, type Model, type Schema, type Types } from "mongoose";

/** Pipeline stages the plan crystalized: queued → fetching → analyzing → verifying → posting → done/failed. */
export type JobState = "queued" | "running" | "done" | "failed";
export type JobStage = "queued" | "fetching" | "analyzing" | "verifying" | "posting";

export type JobType = "repo-audit" | "pr-review" | "report-insights";

/**
 * Mongo-backed durable job (queue swaps to BullMQ behind the same interface
 * later — see server/modules/jobs/queue.ts). Payloads never contain secrets:
 * the worker re-loads + decrypts the user's GitHub token itself.
 */
export interface JobDocument extends Document<Types.ObjectId> {
  type: JobType;
  userId: Types.ObjectId;
  state: JobState;
  /** Human-facing pipeline position (stage names). */
  stage: JobStage;
  /** 0-100 estimate shown by the progress page. */
  percent: number;
  message?: string;
  payload: Record<string, unknown>;
  result?: unknown;
  error?: { message: string };
  /** Claim count; incremented atomically on every claim (incl. lease reclaim). */
  attempts: number;
  maxAttempts: number;
  /** Earliest time the job may be claimed. */
  runAt: Date;
  /** Jobs running longer than this are considered abandoned and re-claimable. */
  leaseUntil?: Date;
  startedAt?: Date;
  finishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const jobSchema: Schema<JobDocument> = new mongoose.Schema(
  {
    type: { type: String, required: true, enum: ["repo-audit", "pr-review", "report-insights"] },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    state: { type: String, default: "queued" },
    stage: { type: String, default: "queued" },
    percent: { type: Number, default: 0 },
    message: { type: String },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    result: { type: mongoose.Schema.Types.Mixed },
    error: {
      type: { message: { type: String } } as unknown,
      default: undefined,
    },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },
    runAt: { type: Date, default: Date.now },
    leaseUntil: { type: Date },
    startedAt: { type: Date },
    finishedAt: { type: Date },
  },
  { timestamps: true },
);

// Claim/scheduling access pattern — this is what queue.claimNext() scans.
jobSchema.index({ state: 1, runAt: 1 });
jobSchema.index({ userId: 1, createdAt: -1 });

export const Job: Model<JobDocument> =
  (mongoose.models.Job as Model<JobDocument>) ||
  mongoose.model<JobDocument>("Job", jobSchema);
