import { AppError } from "./errorHandler";
import type { UserDocument } from "../models/User";

/**
 * Ownership enforcement helpers.
 *
 * SECURITY DESIGN: resources belonging to another user respond with 404, not
 * 403 — object ids must not be enumerable by probing authenticated endpoints.
 * Legacy documents with NO userId (upgraded rows not yet backfilled) are 404
 * for everyone until `script/migrate-ownership.ts` runs.
 */

export function userIdOf(user: UserDocument): string {
  return String((user as { _id: unknown })._id);
}

/**
 * Throws 404 unless `doc` exists AND is owned by `user`.
 * Returns the doc on success (same reference) for ergonomic chaining.
 */
export function assertOwnership<T extends { userId?: unknown }>(
  doc: T | null | undefined,
  user: UserDocument,
  resource: string,
): T {
  if (!doc) {
    throw AppError.notFound(`${resource} not found`);
  }
  const owner = doc.userId != null ? String(doc.userId) : null;
  if (owner !== userIdOf(user)) {
    // Foreign or untagged resource — indistinguishable from "not found"
    throw AppError.notFound(`${resource} not found`);
  }
  return doc;
}
