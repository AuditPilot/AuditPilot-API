import mongoose from "mongoose";
import { UsageRecord, type UsageAction, type UsageRecordDocument } from "../../models/UsageRecord";
import { isUnlimited, planOf, LIMITS } from "../../config/plans";
import { logger } from "../../config/logger";

/**
 * Atomic usage service — the ONLY module that touches usage counts.
 *
 * Semantics ("reserve → consume · release on failure"):
 * - RESERVE happens server-side at action-start (enqueue / route handle),
 *   with amongo-atomic conditional $inc filtered on `count < limit`; two
 *   concurrent requests racing the last slot cannot both win it.
 * - RELEASE refunds a reservation when the work permanently fails
 *   (maxAttempts exceeded) so failed jobs never consume quota.
 * - The UsageRecord LEDGER is the source of truth keyed by UTC month, so
 *   quota resets are structural (new period key), never cron-driven.
 * - Legacy User.auditsUsed / pullRequestsUsed counters are FROZEN at the
 *   C8 switchover: they stay on the schema (no migration) but are no
 *   longer incremented or read for gating; clients receive ledger-based
 *   monthly counts under the same field names.
 */
export const CURRENT_ACTION_LIMITS: Record<UsageAction, (user: { plan?: string }) => number> = {
  "audit": user => LIMITS[planOf(user.plan)].audits,
  "pr-review": user => LIMITS[planOf(user.plan)].pullRequests,
};

/** UTC YYYY-MM key for the current billing period. */
export function currentPeriod(date = new Date()): string {
  // UTC keeps the key stable across server timezones.
  return date.toISOString().slice(0, 7);
}

export interface ReserveResult {
  ok: boolean;
  used?: number;
  limit: number;
}

/**
 * Atomically reserves one unit of `action` for the user's current period.
 * - Returns `ok: false` when the plan's monthly limit is already reached
 *   (the caller maps that to the 402 limit payload).
 */
export async function reserve(userId: string | unknown, action: UsageAction, user: { plan?: string }): Promise<ReserveResult> {
  const limit = CURRENT_ACTION_LIMITS[action](user);
  const period = currentPeriod();
  const ownerId = new mongoose.Types.ObjectId(String(userId));

  // Unlimited plans are counted (analytics) but never gated.
  const filter = isUnlimited(limit)
    ? { userId: ownerId, action, period }
    : { userId: ownerId, action, period, count: { $lt: limit } };

  const doc = await UsageRecord.findOneAndUpdate(
    filter,
    { $inc: { count: 1 } },
    { upsert: true, returnDocument: "after", lean: true },
  ).catch(err => {
    // Defensive: a duplicate-key race on first-ever upsert retried by the
    // driver resolves to the update path; anything else surfaces.
    if (isDuplicateKey(err)) return null;
    throw err;
  });

  if (doc) {
    return { ok: true, limit };
  }

  // Null here means: no doc matched (limit reached) OR first-insert raced
  // and lost. Re-read to distinguish; retry once if the record exists but
  // is below its limit (rare upsert race, previously lost insert).
  const existing = await UsageRecord.findOne(
    { userId: ownerId, action, period },
    null,
    { lean: true },
  );
  if (existing && existing.count < limit) {
    const updated = await UsageRecord.findOneAndUpdate(
      { userId: ownerId, action, period, count: { $lt: limit } },
      { $inc: { count: 1 } },
      { returnDocument: "after", lean: true },
    );
    if (updated) return { ok: true, limit };
  }

  // Rejection: re-read AFTER the failed conditional so concurrent sibling
  // increments still in flight during earlier reads are settled — the
  // reported `used` is the exact count the limit gate failed on.
  const fresh = (await UsageRecord.findOne(
    { userId: ownerId, action, period },
    null,
    { lean: true },
  )) as UsageRecordDocument | null;
  return { ok: false, used: fresh?.count ?? limit, limit };
}

/**
 * Refunds one reserved unit after the work permanently failed. The `$gt: 0`
 * filter is self-clamping: a stale double-release can never drive counts
 * negative, and the decrement stays race-safe without needing a pipeline.
 */
export async function release(userId: string | unknown, action: UsageAction): Promise<void> {
  const period = currentPeriod();
  const ownerId = new mongoose.Types.ObjectId(String(userId));
  try {
    await UsageRecord.updateOne(
      { userId: ownerId, action, period, count: { $gt: 0 } },
      { $inc: { count: -1 } },
    );
  } catch (err) {
    // Refund failures must not mask the original job failure.
    logger.error(
      { err: err instanceof Error ? err.message : String(err), userId: String(userId), action },
      "usage refund failed",
    );
  }
}

/** Current-period count (0 when the user never used this action). */
export async function getUsageCount(userId: string | unknown, action: UsageAction): Promise<number> {
  const period = currentPeriod();
  const ownerId = new mongoose.Types.ObjectId(String(userId));
  const rec = (await UsageRecord.findOne(
    { userId: ownerId, action, period },
    null,
    { lean: true },
  )) as UsageRecordDocument | null;
  return rec?.count ?? 0;
}

/** Ledger-based monthly counts for the client-visible user payload. */
export async function usageForSanitizedUser(userId: string | unknown): Promise<{
  auditsUsed: number;
  pullRequestsUsed: number;
}> {
  const period = currentPeriod();
  const rows = await UsageRecord.find(
    { userId: new mongoose.Types.ObjectId(String(userId)), period },
    null,
    { lean: true },
  );
  const count = (action: UsageAction) => rows.find(r => r.action === action)?.count ?? 0;
  return {
    auditsUsed: count("audit"),
    pullRequestsUsed: count("pr-review"),
  };
}

/** 402 payload — same shape as the legacy planLimitError (client contract). */
export function limitReachedError(plan: string, action: UsageAction, used: number): {
  message: string;
  details: string;
} {
  const noun = action === "audit" ? "audits" : "PR reviews";
  return {
    message: `${plan.charAt(0).toUpperCase() + plan.slice(1)} monthly ${noun} limit reached.`,
    details: `You have used ${used} of your monthly ${noun} allowance. Upgrade for more — usage resets every month.`,
  };
}

function isDuplicateKey(err: unknown): boolean {
  const e = err as { code?: number; name?: string; message?: string };
  return e?.code === 11000 || (e?.name === "MongoServerError" && (e.message?.includes("E11000") ?? false));
}

export type { UsageAction };
