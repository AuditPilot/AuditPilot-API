import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, safeEqual } from "./crypto";

describe("secret encryption (AES-256-GCM)", () => {
  it("round-trips a GitHub token", () => {
    const token = "ghs_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF";
    const envelope = encryptSecret(token);
    expect(envelope.startsWith("v1.")).toBe(true);
    expect(envelope).not.toContain(token);
    expect(decryptSecret(envelope)).toBe(token);
  });

  it("rejects tampered envelopes", () => {
    const envelope = encryptSecret("super-secret-token");
    const parts = envelope.split(".");
    const tampered = [parts[0], parts[1], Buffer.from("tampered-data").toString("base64"), parts[3]].join(".");
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("rejects malformed envelopes", () => {
    expect(() => decryptSecret("garbage")).toThrow();
    expect(() => decryptSecret("v9.aaa.bbb.ccc")).toThrow();
  });

  it("uses a fresh IV per encryption (envelopes differ)", () => {
    const a = encryptSecret("same-value");
    const b = encryptSecret("same-value");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(decryptSecret(b));
  });
});

describe("safeEqual", () => {
  it("matches identical strings", () => {
    expect(safeEqual("hello", "hello")).toBe(true);
  });

  it("rejects different strings", () => {
    expect(safeEqual("hello", "world")).toBe(false);
  });

  it("rejects different-length strings", () => {
    expect(safeEqual("short", "longer-string")).toBe(false);
  });
});
