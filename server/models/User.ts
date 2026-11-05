import mongoose, { type Document, type Model, type Schema } from "mongoose";

export interface UserDocument extends Document {
  githubId: string;
  username: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  email?: string | null;
  /** LEGACY plaintext token — migrated to accessTokenEncrypted on first use. */
  accessToken?: string | null;
  /** AES-256-GCM encrypted GitHub token (never rendered to clients). */
  accessTokenEncrypted?: string | null;
  plan: "starter" | "pro" | "agency";
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  auditsUsed: number;
  pullRequestsUsed: number;
  lastLogin: Date;
}

const UserSchema: Schema<UserDocument> = new mongoose.Schema({
    githubId: { type: String, required: true, unique: true },
    username: { type: String, required: true },
    displayName: { type: String },
    avatarUrl: { type: String },
    email: { type: String },
    accessToken: { type: String, select: false },
    accessTokenEncrypted: { type: String, select: false },
    plan: { type: String, enum: ["starter", "pro", "agency"], default: "starter" },
    stripeCustomerId: { type: String },
    stripeSubscriptionId: { type: String },
    auditsUsed: { type: Number, default: 0 },
    pullRequestsUsed: { type: Number, default: 0 },
    lastLogin: { type: Date, default: Date.now },
}, { timestamps: true });

export const User: Model<UserDocument> =
  (mongoose.models.User as Model<UserDocument>) ||
  mongoose.model<UserDocument>("User", UserSchema);
