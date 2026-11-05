import mongoose, { type Document, type Model, type Schema } from "mongoose";

/**
 * Cost-tracking ledger for every AI call that goes through the gateway
 * (see server/integrations/ai/gateway.ts). One row per model response —
 * including attempts whose output later failed validation, so real spend
 * is visible even when a task ultimately retries/fails.
 */
export interface AIUsageDocument extends Document {
  task: string;
  /** Provider model id actually used. (Named modelName: Document already has a model() method.) */
  modelName: string;
  /** Prompt version tag, e.g. "repo-audit:v1". */
  promptVersion: string;
  promptTokens: number;
  completionTokens: number;
  userId?: mongoose.Types.ObjectId;
  jobId?: mongoose.Types.ObjectId;
  createdAt: Date;
}

const aiUsageSchema: Schema<AIUsageDocument> = new mongoose.Schema(
  {
    task: { type: String, required: true, index: true },
    modelName: { type: String, required: true },
    promptVersion: { type: String, required: true },
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    jobId: { type: mongoose.Schema.Types.ObjectId, ref: "Job", index: true },
  },
  { timestamps: true },
);

aiUsageSchema.index({ userId: 1, createdAt: -1 });
aiUsageSchema.index({ createdAt: -1 });

export const AIUsage: Model<AIUsageDocument> =
  (mongoose.models.AIUsage as Model<AIUsageDocument>) ||
  mongoose.model<AIUsageDocument>("AIUsage", aiUsageSchema);
