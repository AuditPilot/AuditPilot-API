/**
 * Rollback for the M1 workspace foundation.
 *
 * Drops the new collections and $unsets the additive Audit fields. User data
 * (users, audits, items, reports, usage, jobs) is untouched — the migration's
 * only writes were to the new collections plus cloned credentials.
 *
 * Refuses to run without --yes (irreversible).
 *
 * Usage:
 *   npm run workspace:rollback -- --yes
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB, disconnectDB, maskUri } from "../server/config/mongo";

const log = console.log;

const NEW_COLLECTIONS = [
  "workspaces",
  "workspacemembers",
  "providerconnections",
  "repositories",
  "pullrequests",
  "findings",
] as const;

const AUDIT_FIELDS_TO_UNSET = {
  workspaceId: 1,
  repositoryId: 1,
  provider: 1,
  commitSha: 1,
  auditType: 1,
  originatingJobId: 1,
} as const;

async function main(): Promise<void> {
  if (process.argv.includes("--yes") !== true) {
    log("[rollback-workspaces] ABORT: this drops workspace-foundation collections.");
    log("Re-run with --yes to confirm.");
    process.exit(1);
  }

  await connectDB();
  log(`[rollback-workspaces] connected to ${maskUri(process.env.MONGODB_URI ?? "")}`);

  const db = mongoose.connection.db;
  if (!db) throw new Error("no db connection");
  const existing = new Set((await db.listCollections().toArray()).map(c => c.name));

  for (const name of NEW_COLLECTIONS) {
    if (existing.has(name)) {
      await db.dropCollection(name);
      log(`[rollback-workspaces] dropped collection: ${name}`);
    } else {
      log(`[rollback-workspaces] collection absent (skipped): ${name}`);
    }
  }

  const res = await db.collection("audits").updateMany({}, { $unset: AUDIT_FIELDS_TO_UNSET });
  log(`[rollback-workspaces] unset additive Audit fields on ${res.modifiedCount} audits`);

  await disconnectDB();
  log("[rollback-workspaces] done");
}

main().catch(err => {
  log(`[rollback-workspaces] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
