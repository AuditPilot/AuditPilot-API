import mongoose, { type Document, type Model, type Schema, type Types } from "mongoose";

export type PullRequestState = "open" | "closed" | "merged";
export type CheckStatus = "none" | "pending" | "passing" | "failing";

export interface PullRequestDocument extends Document {
  workspaceId: Types.ObjectId;
  repositoryId: Types.ObjectId;
  provider: "github" | "bitbucket";
  /** Provider node id — stable; some providers omit it, number+repo is the fallback key. */
  providerExternalId?: string | null;
  number: number;
  title: string;
  body?: string | null;
  author: {
    login: string;
    avatarUrl?: string | null;
  };
  sourceBranch: string;
  destinationBranch: string;
  state: PullRequestState;
  isDraft: boolean;
  url: string;
  additions: number;
  deletions: number;
  /** Dedupes AI reviews per head; also detects stale-SHA before remediation. */
  headSha?: string | null;
  checkStatus: CheckStatus;
  firstSeenAt: Date;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const pullRequestSchema: Schema<PullRequestDocument> = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true },
    repositoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Repository", required: true },
    provider: { type: String, enum: ["github", "bitbucket"], required: true },
    providerExternalId: { type: String, default: null },
    number: { type: Number, required: true },
    title: { type: String, required: true },
    body: { type: String, default: null },
    author: {
      login: { type: String, required: true },
      avatarUrl: { type: String, default: null },
    },
    sourceBranch: { type: String, default: "" },
    destinationBranch: { type: String, default: "" },
    state: { type: String, enum: ["open", "closed", "merged"], default: "open" },
    isDraft: { type: Boolean, default: false },
    url: { type: String, default: "" },
    additions: { type: Number, default: 0 },
    deletions: { type: Number, default: 0 },
    headSha: { type: String, default: null },
    checkStatus: { type: String, enum: ["none", "pending", "passing", "failing"], default: "none" },
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// One mirror row per provider PR; repo is the addressing scope
pullRequestSchema.index({ repositoryId: 1, provider: 1, number: 1 }, { unique: true });
// Global inbox queries
pullRequestSchema.index({ workspaceId: 1, state: 1, lastSeenAt: -1 });
// Dedupe AI reviews per head SHA
pullRequestSchema.index({ headSha: 1 });

export const PullRequest: Model<PullRequestDocument> =
  (mongoose.models.PullRequest as Model<PullRequestDocument>) ||
  mongoose.model<PullRequestDocument>("PullRequest", pullRequestSchema);
