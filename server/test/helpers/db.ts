import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

/**
 * Shared Mongo test lifecycle.
 *
 * Uses in-memory MongoDB so tests run anywhere (CI included) without a
 * pre-provisioned database. One server per test file; models are registered
 * lazily so cache collisions don't occur between files.
 */
let mongo: MongoMemoryServer | null = null;

export async function startTestDb(dbName = "auditpilot-test"): Promise<string> {
  mongo = await MongoMemoryServer.create({
    instance: { dbName },
  });
  const uri = mongo.getUri(dbName);
  await mongoose.connect(uri);
  return uri;
}

export async function stopTestDb(): Promise<void> {
  await mongoose.disconnect();
  if (mongo) {
    await mongo.stop();
    mongo = null;
  }
}
