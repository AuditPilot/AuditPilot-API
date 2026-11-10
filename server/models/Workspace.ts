import mongoose, { type Document, type Model, type Schema, type Types } from "mongoose";

export type WorkspaceType = "personal" | "team" | "agency";
export type WorkspacePlan = "starter" | "pro" | "agency";

export interface WorkspaceDocument extends Document {
  name: string;
  /** URL-safe, globally unique. Lowercase [a-z0-9-], 1-63 chars. */
  slug: string;
  owner: Types.ObjectId;
  type: WorkspaceType;
  /** Billing moves to workspace level in M9; fields exist from day one. */
  plan: WorkspacePlan;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const workspaceSchema: Schema<WorkspaceDocument> = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      match: /^[a-z0-9][a-z0-9-]{0,62}$/,
    },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: { type: String, enum: ["personal", "team", "agency"], default: "personal" },
    plan: { type: String, enum: ["starter", "pro", "agency"], default: "starter" },
    stripeCustomerId: { type: String, default: null },
    stripeSubscriptionId: { type: String, default: null },
  },
  { timestamps: true },
);

// Globally-unique slug is the workspace's stable external handle
workspaceSchema.index({ slug: 1 }, { unique: true });
workspaceSchema.index({ createdAt: 1 });

export const Workspace: Model<WorkspaceDocument> =
  (mongoose.models.Workspace as Model<WorkspaceDocument>) ||
  mongoose.model<WorkspaceDocument>("Workspace", workspaceSchema);
