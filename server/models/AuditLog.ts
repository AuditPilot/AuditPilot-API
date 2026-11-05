import mongoose from "mongoose";

const auditLogSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    // machine-readable action key, e.g. "auth.login", "repo.fix.applied"
    action: { type: String, required: true, index: true },
    targetType: { type: String }, // "audit" | "pr" | "repo" | "plan" | ...
    targetId: { type: String },
    ip: { type: String },
    userAgent: { type: String },
    // small, non-sensitive metadata (never code content, never tokens)
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 180 }); // keep 180 days
auditLogSchema.index({ userId: 1, createdAt: -1 });

export const AuditLog =
  mongoose.models.AuditLog ||
  mongoose.model("AuditLog", auditLogSchema);
