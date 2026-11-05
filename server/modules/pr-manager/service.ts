import mongoose from "mongoose";
import { DraftPR, type DraftPRDocument } from "../../models/DraftPR";
import { AuditHistory, type AuditHistoryDocument } from "../../models/AuditHistory";
import { AppError } from "../../middleware/errorHandler";

// --- Drafts (thin wrappers; ownership enforced by filtering every query on userId) ---

export async function listDrafts(userId: string) {
  return DraftPR.find({ userId }).sort({ updatedAt: -1 }).lean();
}

export async function createDraft(data: Omit<Partial<DraftPRDocument>, "userId">, userId: string) {
  if (!data.title || !String(data.title).trim()) {
    throw AppError.badRequest("title is required");
  }
  const newDraft = new DraftPR({ ...data, userId });
  return newDraft.save();
}

/** Fetch + update in one query — ownership is part of the filter itself. */
export async function updateDraft(
  id: string,
  userId: string,
  patch: Partial<DraftPRDocument>,
): Promise<DraftPRDocument | null> {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  const { userId: _ignored, _id: _ignoredId, ...rest } = patch;
  return DraftPR.findOneAndUpdate({ _id: id, userId }, { $set: rest }, { new: true }).lean();
}

export async function deleteDraft(id: string, userId: string): Promise<boolean> {
  if (!mongoose.Types.ObjectId.isValid(id)) return false;
  const res = await DraftPR.deleteOne({ _id: id, userId });
  return res.deletedCount > 0;
}

// --- Audit history ---

export async function listAuditHistory(userId: string, prId?: string) {
  const filter: Record<string, unknown> = { userId };
  if (prId) filter.prId = prId;
  return AuditHistory.find(filter).sort({ createdAt: -1 }).lean();
}

export async function createAuditHistory(
  data: Omit<Partial<AuditHistoryDocument>, "userId">,
  userId: string,
) {
  if (!data.prId && !(data.changes?.length)) {
    throw AppError.badRequest("history records need at least prId or one change entry");
  }
  const entry = new AuditHistory({ ...data, userId });
  return entry.save();
}
