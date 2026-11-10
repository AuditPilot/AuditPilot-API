import mongoose, { type Document, type Model, type Schema, type Types } from "mongoose";

export type AuditType = "repo_full" | "pr_review" | "incremental";

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
  // ---- M1 additive workspace-scoping (all nullable; legacy audits never backfilled) ----
  workspaceId?: Types.ObjectId | null;
  repositoryId?: Types.ObjectId | null;
  provider?: "github" | "bitbucket" | null;
  /** HEAD commit the audit ran against (populated by the M6 engine). */
  commitSha?: string | null;
  auditType?: AuditType | null;
  originatingJobId?: Types.ObjectId | null;
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
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", default: null },
    repositoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Repository", default: null },
    provider: { type: String, enum: ["github", "bitbucket"], default: null },
    commitSha: { type: String, default: null },
    auditType: { type: String, enum: ["repo_full", "pr_review", "incremental"], default: null },
    originatingJobId: { type: mongoose.Schema.Types.ObjectId, ref: "Job", default: null },
  },
  { timestamps: true },
);

// Primary access pattern: a user's audits newest-first
auditSchema.index({ userId: 1, createdAt: -1 });
// Workspace-facing listing (legacy rows have no workspaceId — fine, they stay user-scoped)
auditSchema.index({ workspaceId: 1, createdAt: -1 });

export const Audit: Model<AuditDocument> =
  (mongoose.models.Audit as Model<AuditDocument>) ||
  mongoose.model<AuditDocument>("Audit", auditSchema);
