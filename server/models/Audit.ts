import mongoose, { type Document, type Model, type Schema, type Types } from "mongoose";

export interface AuditDocument extends Document {
  /** OWNING USER — every read/write is filtered by this. Indexed. */
  userId?: Types.ObjectId;
  title: string;
  description?: string;
  status: "draft" | "in_progress" | "completed";
  priority: "low" | "medium" | "high" | "critical";
  /** LEGACY pre-ownership field — kept so old documents don't lose data. */
  auditorId?: string;
  scope?: string;
  branch: string;
  createdAt: Date;
  updatedAt: Date;
}

const auditSchema: Schema<AuditDocument> = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    title: { type: String, required: true },
    description: { type: String },
    status: { type: String, default: "draft", enum: ["draft", "in_progress", "completed"] },
    priority: { type: String, default: "medium", enum: ["low", "medium", "high", "critical"] },
    auditorId: { type: String }, // legacy field — superseded by userId ownership
    scope: { type: String },
    branch: { type: String, default: "main" },
  },
  { timestamps: true },
);

// Primary access pattern: a user's audits newest-first
auditSchema.index({ userId: 1, createdAt: -1 });

export const Audit: Model<AuditDocument> =
  (mongoose.models.Audit as Model<AuditDocument>) ||
  mongoose.model<AuditDocument>("Audit", auditSchema);
