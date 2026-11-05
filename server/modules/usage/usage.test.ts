import { beforeAll, afterAll, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { UsageRecord, type UsageRecordDocument } from "../../models/UsageRecord";
import {
  currentPeriod,
  reserve,
  release,
  getUsageCount,
  usageForSanitizedUser,
  limitReachedError,
} from "./service";
import { startTestDb, stopTestDb } from "../../test/helpers/db";

const oid = () => new mongoose.Types.ObjectId();

describe("usage service (atomic reserve/release ledger)", () => {
  beforeAll(async () => {
    await startTestDb("usage-test");
  });

  afterAll(async () => {
    await stopTestDb();
  });

  it("formats the period key as UTC YYYY-MM", () => {
    expect(currentPeriod(new Date(Date.UTC(2026, 0, 3)))).toBe("2026-01");
    expect(currentPeriod(new Date(Date.UTC(2026, 11, 31, 23, 59)))).toBe("2026-12");
    // local-time bias must not leak into the key
    expect(currentPeriod(new Date("2026-05-01T00:30:00+12:00"))).toBe("2026-04");
  });

  it("inserts the ledger row on the first reserve", async () => {
    const userId = oid();
    const first = await reserve(userId, "audit", { plan: "starter" });
    expect(first.ok).toBe(true);

    const row = (await UsageRecord.findOne({ userId })) as UsageRecordDocument;
    expect(row.action).toBe("audit");
    expect(row.period).toBe(currentPeriod());
    expect(row.count).toBe(1);
  });

  it("cannot over-consume the monthly limit under concurrency", async () => {
    // starter pr-review limit = 2 — race 8 reserve attempts
    const prUserId = oid();
    const prAttempts = await Promise.all(
      Array.from({ length: 8 }, () => reserve(prUserId, "pr-review", { plan: "starter" })),
    );
    expect(prAttempts.filter(r => r.ok)).toHaveLength(2);
    expect((await getUsageCount(prUserId, "pr-review"))).toBe(2);

    // starter audit limit = 5 — race 12 attempts
    const auditUserId = oid();
    const auditAttempts = await Promise.all(
      Array.from({ length: 12 }, () => reserve(auditUserId, "audit", { plan: "starter" })),
    );
    expect(auditAttempts.filter(r => r.ok)).toHaveLength(5);
    expect((await getUsageCount(auditUserId, "audit"))).toBe(5);

    // rejected attempts report the full usage so the 402 payload can show it
    const rejected = auditAttempts.find(r => !r.ok)!;
    expect(rejected.used).toBe(5);
  });

  it("clamps refunds at zero and keeps the slot usable afterward", async () => {
    const userId = oid();
    await reserve(userId, "audit", { plan: "starter" });
    // double-release beyond the available count must never go negative
    await release(userId, "audit");
    await release(userId, "audit");
    await release(userId, "audit");
    expect(await getUsageCount(userId, "audit")).toBe(0);

    // and the account still works after the clamp
    const again = await reserve(userId, "audit", { plan: "starter" });
    expect(again.ok).toBe(true);
    expect(await getUsageCount(userId, "audit")).toBe(1);
  });

  it("does not leak usage across period keys (monthly reset)", async () => {
    const userId = oid();
    const now = new Date();
    const prevPeriod = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
    ).toISOString().slice(0, 7);

    await UsageRecord.create({ userId, action: "audit", period: prevPeriod, count: 5 });

    // new month: previous rows are invisible to gating and reporting
    expect(await getUsageCount(userId, "audit")).toBe(0);
    const result = await reserve(userId, "audit", { plan: "starter" });
    expect(result.ok).toBe(true);
    expect(await getUsageCount(userId, "audit")).toBe(1);
  });

  it("counts but never gates unlimited plans", async () => {
    const userId = oid();
    const results = await Promise.all(
      Array.from({ length: 25 }, () => reserve(userId, "audit", { plan: "agency" })),
    );
    expect(results.every(r => r.ok)).toBe(true);
    expect(await getUsageCount(userId, "audit")).toBe(25);
  });

  it("reports ledger counts under the legacy payload field names", async () => {
    const userId = oid();
    await reserve(userId, "audit", { plan: "pro" });
    await reserve(userId, "pr-review", { plan: "pro" });
    const usage = await usageForSanitizedUser(userId);
    expect(usage).toEqual({ auditsUsed: 1, pullRequestsUsed: 1 });
  });

  it("returns a 402-shaped payload (client contract)", () => {
    const payload = limitReachedError("starter", "audit", 5);
    expect(Object.keys(payload)).toEqual(["message", "details"]);
    expect(payload.message).toContain("monthly");
    expect(payload.details).toContain("5");
  });
});
