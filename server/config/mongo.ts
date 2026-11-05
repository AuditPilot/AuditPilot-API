import mongoose from "mongoose";
import { ENV } from "./env";
import { logger } from "./logger";

/** Mask credentials in a Mongo URI before logging it. */
export function maskUri(uri: string): string {
  return uri.replace(/:([^@]+)@/, ":****@");
}

let connected = false;

export async function connectDB(): Promise<void> {
  if (connected) {
    return;
  }

  const uri = ENV.MONGODB_URI;
  logger.info({ uri: maskUri(uri) }, "connecting to MongoDB");

  try {
    await mongoose.connect(uri);
    connected = true;
    logger.info("connected to MongoDB");
  } catch (err) {
    logger.error({ err, uri: maskUri(uri) }, "MongoDB connection error");
    throw err;
  }

  mongoose.connection.on("error", err => {
    logger.error({ err: (err as Error).message }, "MongoDB runtime error");
  });

  mongoose.connection.on("disconnected", () => {
    logger.warn("MongoDB disconnected");
    connected = false;
  });

  mongoose.connection.on("reconnected", () => {
    logger.info("MongoDB reconnected");
    connected = true;
  });
}

export async function disconnectDB(): Promise<void> {
  if (!connected) {
    return;
  }
  await mongoose.disconnect();
  connected = false;
}
