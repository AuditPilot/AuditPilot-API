import "dotenv/config";
import mongoose from "mongoose";
import { createDecipheriv, createHash } from "node:crypto";

const jwtSecret = process.env.JWT_SECRET;
const key = createHash("sha256").update(`enc:${jwtSecret}`).digest();

await mongoose.connect(process.env.MONGODB_URI);
const user = await mongoose.connection.db
  .collection("users")
  .findOne({ githubId: "93979118" });
await mongoose.disconnect();

if (!user || !user.accessTokenEncrypted) {
  console.error("NO_ENCRYPTED_TOKEN");
  process.exit(1);
}

const parts = user.accessTokenEncrypted.split(".");
const [, ivB64, ctB64, tagB64] = parts;
const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
decipher.setAuthTag(Buffer.from(tagB64, "base64"));
const plaintext = Buffer.concat([
  decipher.update(Buffer.from(ctB64, "base64")),
  decipher.final(),
]).toString("utf8");

process.stdout.write(plaintext);
