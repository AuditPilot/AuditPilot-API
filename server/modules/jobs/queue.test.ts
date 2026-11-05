import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestDb, stopTestDb } from "../../test/helpers/db";
import { enqueue, claimNext, setProgress, complete, fail, getById, LEASE_MS } from "./queue";
import { Job } from "./model";

beforeAll(async () => {
  await startTestDb("queue-test");
}, 180_000);

afterAll(async () => {
  await stopTestDb();
}, 60_000);

describe("job queue (mongo adapter)", () => {
  it("enqueue → claim atomically moves the job queued→running and counts the attempt", async () => {
    const job = await enqueue({
      type: "repo-audit",
      userId: "5f1a2b3c4d5e6f7890a1b2c3",
      payload: { owner: "acme", repo: "api" },
    });

    expect(job._id).toBeDefined();
    expect(job.state).toBe("queued");
    expect(job.attempts).toBe(0);

    const claimed = await claimNext();
    expect(claimed).not.toBeNull();
    expect(String(claimed!._id)).toBe(String(job._id));
    expect(claimed!.state).toBe("running");
    expect(claimed!.stage).toBe("fetching");
    expect(claimed!.attempts).toBe(1);
    expect(claimed!.leaseUntil).toBeDefined();
  });

  it("claimNext returns null when nothing is claimable (no double-claim)", async () => {
    await Job.deleteMany({});
    const job = await enqueue({ type: "pr-review", userId: "5f1a2b3c4d5e6f7890a1b2c3", payload: {} });

    const first = await claimNext();
    expect(String(first!._id)).toBe(String(job._id));
    // The job is now running with a fresh lease — the second claimer gets nothing.
    const second = await claimNext();
    expect(second).toBeNull();

    // Jobs scheduled for the future are not claimable yet
    await Job.deleteMany({});
    await enqueue({
      type: "repo-audit",
      userId: "5f1a2b3c4d5e6f7890a1b2c3",
      payload: {},
      runAt: new Date(Date.now() + 60_000),
    });
    expect(await claimNext()).toBeNull();
  });

  it("claimNext prefers the OLDEST runnable job (FIFO by runAt)", async () => {
    await Job.deleteMany({});
    // Enqueue order = claim order: the oldest job wins.
    const early = await enqueue({ type: "repo-audit", userId: "5f1a2b3c4d5e6f7890a1b2c3", payload: { n: 1 } });
    const late = await enqueue({ type: "repo-audit", userId: "5f1a2b3c4d5e6f7890a1b2c3", payload: { n: 2 } });

    const claimed = await claimNext();
    expect(String(claimed!._id)).toBe(String(early._id));
    expect(String(claimed!._id)).not.toBe(String(late._id));
  });

  it("expired leases are reclaimed (crash recovery) and attempts keep counting", async () => {
    await Job.deleteMany({});
    const job = await enqueue({ type: "repo-audit", userId: "5f1a2b3c4d5e6f7890a1b2c3", payload: {} });

    await claimNext(); // "worker dies" — job stuck running with a lease
    await Job.updateOne({ _id: job._id }, { $set: { leaseUntil: new Date(Date.now() - LEASE_MS - 1_000) } });

    const reclaimed = await claimNext();
    expect(String(reclaimed!._id)).toBe(String(job._id));
    expect(reclaimed!.attempts).toBe(2); // claimed twice (1 + reclaimed 1)
    expect(reclaimed!.state).toBe("running");
  });

  it("setProgress updates stage/percent/message and complete() closes the job", async () => {
    await Job.deleteMany({});
    const job = await enqueue({ type: "report-insights", userId: "5f1a2b3c4d5e6f7890a1b2c3", payload: {} });
    await claimNext();

    await setProgress(job._id, { stage: "analyzing", percent: 55, message: "thinking…" });
    let current = await getById(job._id);
    expect(current!.state).toBe("running");
    expect(current!.percent).toBe(55);
    expect(current!.message).toBe("thinking…");

    await complete(job._id, { reportId: "abc" });
    current = await getById(job._id);
    expect(current!.state).toBe("done");
    expect(current!.percent).toBe(100);
    expect((current!.result as { reportId?: string }).reportId).toBe("abc");

    // Completed jobs are not claimable again
    expect(await claimNext()).toBeNull();
  });

  it("fail() requeues with backoff while attempts remain, then fails permanently", async () => {
    await Job.deleteMany({});
    const job = await enqueue({
      type: "repo-audit",
      userId: "5f1a2b3c4d5e6f7890a1b2c3",
      payload: {},
      maxAttempts: 2,
    });

    await claimNext(); // attempts=1 (running)
    const retried = await fail(job._id, new Error("transient AI error"));
    expect(retried!.state).toBe("queued");
    expect(retried!.attempts).toBe(1);
    expect((retried!.error as { message: string }).message).toBe("transient AI error");
    expect(retried!.runAt.getTime()).toBeGreaterThan(Date.now()); // backoff scheduled

    // Backoff scheduled the retry ~30s out — make it claimable now.
    await Job.updateOne({ _id: job._id }, { $set: { runAt: new Date(Date.now() - 1_000) } });
    const claimedAgain = await claimNext();
    expect(String(claimedAgain!._id)).toBe(String(job._id));
    expect(claimedAgain!.attempts).toBe(2);

    const final = await fail(job._id, new Error("still broken"));
    expect(final!.state).toBe("failed");
    expect((final!.error as { message: string }).message).toBe("still broken");
    expect(final!.finishedAt).toBeDefined();
  });

  it("fail() with maxAttempts exceeded via override fails immediately (poison job)", async () => {
    await Job.deleteMany({});
    const job = await enqueue({ type: "repo-audit", userId: "5f1a2b3c4d5e6f7890a1b2c3", payload: {} });
    await claimNext();

    const failed = await fail(job._id, "no handler for this type", 0);
    expect(failed!.state).toBe("failed");
  });
});
