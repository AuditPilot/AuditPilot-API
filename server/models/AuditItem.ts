import mongoose, { type Document, type Model, type Schema, type Types } from "mongoose";

export interface AuditItemDocument extends Document {
  /** Mirrors the owning user of the parent audit — required for direct item access control. */
  userId?: Types.ObjectId;
  auditId: Types.ObjectId;
  label: string;
  type: string; // security | performance | accessibility | ...
  value?: string; // file path
  severity: "low" | "medium" | "high" | "critical";
  old_code?: string;
  new_code?: string;
  complianceStatus: "compliant" | "non_compliant" | "needs_review" | "pending";
  auditorNotes?: string;
  createdAt: Date;
}

const auditItemSchema: Schema<AuditItemDocument> = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    auditId: { type: mongoose.Schema.Types.ObjectId, ref: "Audit", required: true },
    label: { type: String, required: true },
    type: { type: String, required: true },
    value: { type: String },
    severity: { type: String, enum: ["low", "medium", "high", "critical"], default: "medium" },
    old_code: { type: String },
    new_code: { type: String },
    complianceStatus: { type: String, enum: ["compliant", "non_compliant", "needs_review", "pending"], default: "pending" },
    auditorNotes: { type: String },
}, { timestamps: true });

// Direct-item access + audit-scoped listing
auditItemSchema.index({ userId: 1, auditId: 1 });
auditItemSchema.index({ auditId: 1, severity: 1 });

export const AuditItem: Model<AuditItemDocument> =
  (mongoose.models.AuditItem as Model<AuditItemDocument>) ||
  mongoose.model<AuditItemDocument>("AuditItem", auditItemSchema);
