import mongoose, { type Document, type Model, type Schema, type Types } from "mongoose";

/** One file the user edited while compositing a PR draft. */
export interface DraftPRFileDocument {
  fileName: string;
  oldCode: string;
  newCode: string;
  status: "pending" | "edited" | "committed";
}

export interface DraftPRDocument extends Document {
  /** OWNING USER — every read/write is filtered by this. Indexed. */
  userId?: Types.ObjectId;
  title: string;
  description?: string;
  /** Per-file before/after code captured in the PR editor. */
  filesChanged: DraftPRFileDocument[];
  /** GitHub context needed to open the final PR from this draft. */
  owner?: string;
  repo?: string;
  targetBranch?: string;
  prUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

const draftPRSchema: Schema<DraftPRDocument> = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    filesChanged: [
      {
        fileName: { type: String, default: "" },
        oldCode: { type: String, default: "" },
        newCode: { type: String, default: "" },
        status: { type: String, default: "pending", enum: ["pending", "edited", "committed"] },
      },
    ],
    owner: { type: String },
    repo: { type: String },
    targetBranch: { type: String },
    prUrl: { type: String },
  },
  { timestamps: true },
);

// A user's drafts newest-first
draftPRSchema.index({ userId: 1, updatedAt: -1 });

export const DraftPR: Model<DraftPRDocument> =
  (mongoose.models.DraftPR as Model<DraftPRDocument>) ||
  mongoose.model<DraftPRDocument>("DraftPR", draftPRSchema);
