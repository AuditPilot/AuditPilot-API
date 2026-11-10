import mongoose, { type Document, type Model, type Schema, type Types } from "mongoose";

/** Role hierarchy: owner > admin > developer > viewer */
export const WORKSPACE_ROLES = ["owner", "admin", "developer", "viewer"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

const ROLE_RANK: Record<WorkspaceRole, number> = {
  owner: 4,
  admin: 3,
  developer: 2,
  viewer: 1,
};

export function roleAtLeast(role: WorkspaceRole, min: WorkspaceRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export type MemberStatus = "active" | "invited" | "suspended";

export interface WorkspaceMemberDocument extends Document {
  workspaceId: Types.ObjectId;
  userId: Types.ObjectId;
  role: WorkspaceRole;
  status: MemberStatus;
  /** Invitation scaffolding — invitations flow lands in M8. */
  invitedBy?: Types.ObjectId | null;
  invitedAt?: Date | null;
  joinedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const workspaceMemberSchema: Schema<WorkspaceMemberDocument> = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    role: { type: String, enum: WORKSPACE_ROLES, default: "developer" },
    status: { type: String, enum: ["active", "invited", "suspended"], default: "active" },
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    invitedAt: { type: Date, default: null },
    joinedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// One membership (and therefore one role) per user per workspace — enforced atomically
workspaceMemberSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });
workspaceMemberSchema.index({ userId: 1 });

export const WorkspaceMember: Model<WorkspaceMemberDocument> =
  (mongoose.models.WorkspaceMember as Model<WorkspaceMemberDocument>) ||
  mongoose.model<WorkspaceMemberDocument>("WorkspaceMember", workspaceMemberSchema);
