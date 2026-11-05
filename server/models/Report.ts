import mongoose, { type Document, type Model, type Schema, type Types } from "mongoose";

export interface ReportDocument extends Document {
  /** Mirrors the owning user of the parent audit — required for report access control. */
  userId?: Types.ObjectId;
  auditId: Types.ObjectId | string;
  summary?: unknown; // string or structured AI output
  riskScore?: number;
  generatedContent?: unknown;
  createdAt: Date;
}

const reportSchema: Schema<ReportDocument> = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    auditId: { type: mongoose.Schema.Types.ObjectId, ref: "Audit", required: true },
    summary: { type: mongoose.Schema.Types.Mixed },
    riskScore: { type: Number },
    generatedContent: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });

reportSchema.index({ userId: 1, createdAt: -1 });
reportSchema.index({ auditId: 1 });

export const Report: Model<ReportDocument> =
  (mongoose.models.Report as Model<ReportDocument>) ||
  mongoose.model<ReportDocument>("Report", reportSchema);
