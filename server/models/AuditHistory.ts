import mongoose, { type Document, type Model, type Schema, type Types } from "mongoose";

/** One before/after code change belonging to an audit record. */
export interface AuditChangeDocument {
  fileName: string;
  /** Original 1-based line numbers the change touches (may be empty for snippet fixes). */
  lineNumbers: number[];
  oldCode: string;
  newCode: string;
}

export interface AuditHistoryDocument extends Document {
  /** OWNING USER — every read/write is filtered by this. Indexed. */
  userId?: Types.ObjectId;
  /** Pull request this audit entry was recorded against (PR number as string, or any external id). */
  prId: string;
  prUrl?: string;
  /** Human/AI summary of what the fix does — rendered at the top of the diff modal. */
  aiFixSummary: string;
  changes: AuditChangeDocument[];
  createdAt: Date;
  updatedAt: Date;
}

const auditHistorySchema: Schema<AuditHistoryDocument> = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    prId: { type: String, default: "" },
    prUrl: { type: String },
    aiFixSummary: { type: String, default: "" },
    changes: [
      {
        fileName: { type: String, default: "" },
        lineNumbers: { type: [Number], default: [] },
        oldCode: { type: String, default: "" },
        newCode: { type: String, default: "" },
      },
    ],
  },
  { timestamps: true },
);

// A user's audit history newest-first (and quick PR lookup)
auditHistorySchema.index({ userId: 1, createdAt: -1 });
auditHistorySchema.index({ prId: 1 });

export const AuditHistory: Model<AuditHistoryDocument> =
  (mongoose.models.AuditHistory as Model<AuditHistoryDocument>) ||
  mongoose.model<AuditHistoryDocument>("AuditHistory", auditHistorySchema);
