import mongoose, { type Document, type Model, type Schema, type Types } from "mongoose";

export type RepoVisibility = "public" | "private" | "internal";
export type RepoSyncState = "pending" | "active" | "error" | "removed";

export interface RepositoryDocument extends Document {
  workspaceId: Types.ObjectId;
  providerConnectionId: Types.ObjectId;
  provider: "github" | "bitbucket";
  /** Provider's stable repo identity (GitHub node id / Bitbucket uuid) — survives renames. */
  providerExternalId: string;
  ownerLabels: {
    account: string;
    fullName: string;
  };
  name: string;
  description?: string | null;
  visibility: RepoVisibility;
  archived: boolean;
  defaultBranch?: string | null;
  syncState: RepoSyncState;
  lastSyncedAt?: Date | null;
  /** Soft-remove bookkeeping (reconciliation lands in M3). */
  connectionRemovedAt?: Date | null;
  removedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const repositorySchema: Schema<RepositoryDocument> = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true },
    providerConnectionId: { type: mongoose.Schema.Types.ObjectId, ref: "ProviderConnection", required: true },
    provider: { type: String, enum: ["github", "bitbucket"], required: true },
    providerExternalId: { type: String, required: true },
    ownerLabels: {
      account: { type: String, required: true },
      fullName: { type: String, required: true },
    },
    name: { type: String, required: true },
    description: { type: String, default: null },
    visibility: { type: String, enum: ["public", "private", "internal"], default: "private" },
    archived: { type: Boolean, default: false },
    defaultBranch: { type: String, default: null },
    syncState: { type: String, enum: ["pending", "active", "error", "removed"], default: "pending" },
    lastSyncedAt: { type: Date, default: null },
    connectionRemovedAt: { type: Date, default: null },
    removedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// The same external repository cannot be registered twice inside one workspace
repositorySchema.index(
  { workspaceId: 1, provider: 1, providerExternalId: 1 },
  { unique: true },
);
repositorySchema.index({ providerConnectionId: 1 });
repositorySchema.index({ workspaceId: 1, syncState: 1 });

export const Repository: Model<RepositoryDocument> =
  (mongoose.models.Repository as Model<RepositoryDocument>) ||
  mongoose.model<RepositoryDocument>("Repository", repositorySchema);
