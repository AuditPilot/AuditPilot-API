import mongoose, { type Document, type Model, type Schema, type Types } from "mongoose";

export type ProviderKind = "oauth-user" | "github-app";
export type ProviderName = "github" | "bitbucket";
export type ConnectionState = "connected" | "revoked" | "error";

export interface ProviderConnectionDocument extends Document {
  workspaceId: Types.ObjectId;
  provider: ProviderName;
  /** Identity auth vs. repository integration credentials are separate concerns. */
  kind: ProviderKind;
  connectedByUserId?: Types.ObjectId | null;
  /** Provider's immutable account id (GitHub numeric user id) — survives renames. */
  providerAccountId: string;
  providerAccountLogin?: string | null;
  providerAccountType?: "User" | "Organization" | null;
  scopes: string[];
  /** AES-256-GCM envelope (same scheme as User tokens) — never returned to clients. */
  credentialsEncrypted: string;
  credentialExpiresAt?: Date | null;
  /** Bitbucket Cloud refresh tokens (M5); GitHub App tokens (M3) are minted per-installation. */
  refreshEncrypted?: string | null;
  refreshExpiresAt?: Date | null;
  status: ConnectionState;
  createdAt: Date;
  updatedAt: Date;
}

const providerConnectionSchema: Schema<ProviderConnectionDocument> = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true },
    provider: { type: String, enum: ["github", "bitbucket"], required: true },
    kind: { type: String, enum: ["oauth-user", "github-app"], default: "oauth-user" },
    connectedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    providerAccountId: { type: String, required: true },
    providerAccountLogin: { type: String, default: null },
    providerAccountType: { type: String, enum: ["User", "Organization"], default: null },
    scopes: { type: [String], default: [] },
    credentialsEncrypted: { type: String, required: true, select: false },
    credentialExpiresAt: { type: Date, default: null },
    refreshEncrypted: { type: String, default: null, select: false },
    refreshExpiresAt: { type: Date, default: null },
    status: { type: String, enum: ["connected", "revoked", "error"], default: "connected" },
  },
  { timestamps: true },
);

providerConnectionSchema.index({ workspaceId: 1 });
providerConnectionSchema.index({ connectedByUserId: 1 });

export const ProviderConnection: Model<ProviderConnectionDocument> =
  (mongoose.models.ProviderConnection as Model<ProviderConnectionDocument>) ||
  mongoose.model<ProviderConnectionDocument>("ProviderConnection", providerConnectionSchema);
