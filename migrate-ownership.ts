/**
 * Ownership backfill migration.
 *
 * Context: Audit / AuditItem / Report gained a `userId` field. Documents
 * created before that change have no owner and are hidden from every user
 * (404 for anyone) until this script assigns them to the designated legacy
 * owner.
 *
 * Usage:
 *   LEGACY_DATA_USER_ID=<24-hex mongodb id> npm run migrate
 *
 * Optional: MONGODB_URI (defaults to env / localhost audit-pilot)
 * Dry run:   DRY_RUN=1
 */
import "dotenv/config";
import mongoose from "mongoose";

// eslint-disable-next-line no-console
const log = console.log;

async function main(): Promise<void> {
  const legacyUserId = process.env.LEGACY_DATA_USER_ID;
  if (!legacyUserId || !/^[0-9a-fA-F]{24}$/.test(legacyUserId)) {
    log("[migrate-ownership] LEGACY_DATA_USER_ID must be a 24-character hex MongoDB id.");
    log("Find it with: mongosh --eval 'db.users.find({}, {_id:1, username:1})'");
    process.exit(1);
  }

  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/audit-pilot";
  log(`[migrate-ownership] connecting to ${uri.replace(/:([^@]+)@/, ":****@")}`);

  await mongoose.connect(uri);

  const db = mongoose.connection.db;
  if (!db) {
    log("[migrate-ownership] FAILED: no database connection");
    await mongoose.disconnect();
    process.exit(1);
  }

  const ownerId = new mongoose.Types.ObjectId(legacyUserId);
  const ownerExists = await db.collection("users").countDocuments({ _id: ownerId });
  if (ownerExists === 0) {
    log(`[migrate-ownership] ABORT: user ${legacyUserId} does not exist in this database.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const dryRun = process.env.DRY_RUN === "1";
  if (dryRun) log("[migrate-ownership] DRY RUN â€” no writes will be performed.");

  let auditCount = 0;
  let itemCount = 0;
  let reportCount = 0;

  if (!dryRun) {
    const audits = await db.collection("audits").updateMany(
      { $or: [{ userId: null }, { userId: { $exists: false } }] },
      { $set: { userId: ownerId } },
    );
    auditCount = audits.modifiedCount;

    // Items under a backfilled audit inherit that audit's owner; anything
    // still untagged (orphaned items) goes to the designated legacy user.
    const itemRes = await db.collection("audititems").updateMany(
      { $or: [{ userId: null }, { userId: { $exists: false } }] },
      { $set: { userId: ownerId } },
    );
    itemCount = itemRes.modifiedCount;

    const reportRes = await db.collection("reports").updateMany(
      { $or: [{ userId: null }, { userId: { $exists: false } }] },
      { $set: { userId: ownerId } },
    );
    reportCount = reportRes.modifiedCount;
  } else {
    auditCount = await db.collection("audits").countDocuments({
      $or: [{ userId: null }, { userId: { $exists: false } }],
    });
    itemCount = await db.collection("audititems").countDocuments({
      $or: [{ userId: null }, { userId: { $exists: false } }],
    });
    reportCount = await db.collection("reports").countDocuments({
      $or: [{ userId: null }, { userId: { $exists: false } }],
    });
  }

  log(
    `[migrate-ownership] done${dryRun ? " (DRY RUN)" : ""}: ` +
      `audits=${auditCount}, items=${itemCount}, reports=${reportCount} â†’ owner=${legacyUserId}`,
  );

  await mongoose.disconnect();
}

main().catch(err => {
  log(`[migrate-ownership] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});


