import mongoose, { type Document, type Model, type Schema, type Types } from "mongoose";

export type FindingSeverity = "critical" | "high" | "medium" | "low";
export type FindingCategory =
  | "security"
  | "performance"
  | "quality"
  | "dependency"
  | "configuration"
  | "accessibility"
  | "architecture";
export type FindingStatus =
  | "open"
  | "in_progress"
  | "fixed"
  | "verified"
  | "accepted_risk"
  | "ignored"
  | "reopened";

/**
 * A Finding is the long-lived issue; AuditItem is its evidence in one audit run.
 * Dedupe spine: deterministic fingerprint, versioned so the algorithm can evolve.
 */
export interface FindingDocument extends Document {
  workspaceId: Types.ObjectId;
  repositoryId: Types.ObjectId;
  auditId?: Types.ObjectId | null;
  /** "v1:<hash>" — stable across audit runs and best-effort across minor file churn. */
  fingerprint: string;
  ruleId?: string | null;
  severity: FindingSeverity;
  category: FindingCategory;
  confidence: number;
  filePath: string;
  lineStart?: number | null;
  lineEnd?: number | null;
  evidence: {
    excerpt?: string | null;
    oldCode?: string | null;
    context?: string | null;
  };
  description: string;
  recommendation?: string | null;
  status: FindingStatus;
  firstDetectedAt: Date;
  lastDetectedAt: Date;
  resolvedAt?: Date | null;
  relatedPullRequests: Types.ObjectId[];
  relatedCommits: string[];
  createdAt: Date;
  updatedAt: Date;
}

const findingSchema: Schema<FindingDocument> = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true },
    repositoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Repository", required: true },
    auditId: { type: mongoose.Schema.Types.ObjectId, ref: "Audit", default: null },
    fingerprint: { type: String, required: true },
    ruleId: { type: String, default: null },
    severity: { type: String, enum: ["critical", "high", "medium", "low"], required: true },
    category: {
      type: String,
      enum: ["security", "performance", "quality", "dependency", "configuration", "accessibility", "architecture"],
      required: true,
    },
    confidence: { type: Number, min: 0, max: 1, default: 0.5 },
    filePath: { type: String, required: true },
    lineStart: { type: Number, default: null },
    lineEnd: { type: Number, default: null },
    evidence: {
      excerpt: { type: String, default: null },
      oldCode: { type: String, default: null },
      context: { type: String, default: null },
    },
    description: { type: String, required: true },
    recommendation: { type: String, default: null },
    status: { type: String, enum: ["open", "in_progress", "fixed", "verified", "accepted_risk", "ignored", "reopened"], default: "open" },
    firstDetectedAt: { type: Date, default: Date.now },
    lastDetectedAt: { type: Date, default: Date.now },
    resolvedAt: { type: Date, default: null },
    relatedPullRequests: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    relatedCommits: { type: [String], default: [] },
  },
  { timestamps: true },
);

// Same issue detected twice = one row, updated (upsert spine)
findingSchema.index({ repositoryId: 1, fingerprint: 1 }, { unique: true });
findingSchema.index({ workspaceId: 1, repositoryId: 1, status: 1 });
findingSchema.index({ repositoryId: 1, severity: 1 });
findingSchema.index({ firstDetectedAt: 1 });

export const Finding: Model<FindingDocument> =
  (mongoose.models.Finding as Model<FindingDocument>) ||
  mongoose.model<FindingDocument>("Finding", findingSchema);
