import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ENV } from "../config/env";

/**
 * AES-256-GCM encryption for secrets at rest (GitHub access tokens).
 * Envelope format: "v1.<iv-b64>.<ciphertext+b64>.<tag-b64>"
 */

const VERSION = "v1";

function key(): Buffer {
  const k = Buffer.from(ENV.ENCRYPTION_KEY as string, "hex");
  if (k.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be a 64-hex-char (32-byte) key");
  }
  return k;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), ciphertext.toString("base64"), tag.toString("base64")].join(".");
}

export function decryptSecret(envelope: string): string {
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Malformed encrypted envelope");
  }
  const [, ivB64, ctB64, tagB64] = parts;
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]);
  return plaintext.toString("utf8");
}

/** Constant-time string comparison of digests (use for webhook/OAuth signatures). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHmac("sha256", "cmp").update(a).digest();
  const hb = createHmac("sha256", "cmp").update(b).digest();
  return timingSafeEqual(ha, hb);
}
