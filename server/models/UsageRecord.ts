import mongoose, { type Document, type Model, type Schema, type Types } from "mongoose";

/**
 * Usage ledger — the single source of truth for plan-quota consumption.
 *
 * One row per (user × action × monthly period). The month key makes resets
 * structural: a new period simply starts at 0 (no cron job needed).
 *
 * Actions:
 * - "audit"     — repository deep audits (started when a job is ENQUEUED,
 *                 refunded if the job permanently fails)
 * - "pr-review" — PR AI reviews (reserved before the review runs)
 * Merges/fixes intentionally do NOT consume quota ("one meaning per action").
 */
export type UsageAction = "audit" | "pr-review";

export interface UsageRecordDocument extends Document<Types.ObjectId> {
  userId: Types.ObjectId;
  action: UsageAction;
  /** UTC "YYYY-MM" billing period key. */
  period: string;
  count: number;
  updatedAt: Date;
  createdAt: Date;
}

const usageRecordSchema: Schema<UsageRecordDocument> = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    action: { type: String, required: true, enum: ["audit", "pr-review"] },
    period: { type: String, required: true }, // "YYYY-MM"
    count: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

// Identity of a (user × action × month) counter — unique so races can't
// create duplicates; upserts converging on the same key retry as updates.
usageRecordSchema.index({ userId: 1, action: 1, period: 1 }, { unique: true });
usageRecordSchema.index({ period: 1 });

export const UsageRecord: Model<UsageRecordDocument> =
  (mongoose.models.UsageRecord as Model<UsageRecordDocument>) ||
  mongoose.model<UsageRecordDocument>("UsageRecord", usageRecordSchema);
