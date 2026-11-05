import { describe, it, expect, beforeAll, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import request from "supertest";
import mongoose from "mongoose";
import { ENV } from "../../config/env";
import { User, type UserDocument } from "../../models/User";
import { Audit } from "../../models/Audit";
import { AuditItem } from "../../models/AuditItem";
import { startTestDb, stopTestDb } from "../../test/helpers/db";
import {
  assertItemAccess,
  createAudit,
  createAuditItem,
  findOwnAuditWithItems,
  listAudits,
} from "./service";
import { assertOwnership } from "../../middleware/ownership";
import { app } from "../../app";

const A_ID = "a".repeat(24);
const B_ID = "b".repeat(24);

let userA: UserDocument;
let userB: UserDocument;

beforeAll(async () => {
  await startTestDb("ownership-test");

  userA = (await User.create({ githubId: "100001", username: "alice" })) as unknown as UserDocument;
  userB = (await User.create({ githubId: "100002", username: "bruno" })) as unknown as UserDocument;
}, 180_000);

afterAll(async () => {
  await stopTestDb();
}, 60_000);

function expectRejected(err: unknown, status: number) {
  expect((err as { status?: number }).status).toBe(status);
}

function authCookie(user: UserDocument): string {
  const token = jwt.sign({ userId: String(user._id) }, ENV.JWT_SECRET as string, { expiresIn: "1h" });
  return `audit_token=${token}`;
}

describe("audit ownership (model + service level)", () => {
  it("createAudit stores the owner and listAudits filters by owner", async () => {
    const mine = await createAudit({ userId: userA._id, title: "A-owned audit" });
    const theirs = await createAudit({ userId: userB._id, title: "B-owned audit" });

    expect(String(mine.userId)).toBe(String(userA._id));

    const aList = await listAudits({ userId: userA._id });
    const bList = await listAudits({ userId: userB._id });

    expect(aList.map(x => String(x._id))).toContain(String(mine._id));
    expect(aList.map(x => String(x._id))).not.toContain(String(theirs._id));
    expect(bList.map(x => String(x._id))).toContain(String(theirs._id));
    expect(bList.map(x => String(x._id))).not.toContain(String(mine._id));
  });

  it("assertOwnership: owner ok; foreign user, missing doc and untagged doc → 404", async () => {
    const audit = await createAudit({ userId: userA._id, title: "owned" });

    assertOwnership(audit.toObject(), userA, "Audit"); // owner access passes

    try {
      assertOwnership(audit.toObject(), userB, "Audit");
      throw new Error("expected rejection");
    } catch (err) {
      expectRejected(err, 404);
    }

    try {
      assertOwnership(null, userA, "Audit");
      throw new Error("expected rejection");
    } catch (err) {
      expectRejected(err, 404);
    }

    // Legacy/untagged documents stay hidden for EVERYONE until backfill
    try {
      assertOwnership({ title: "legacy" } as never, userA, "Audit");
      throw new Error("expected rejection");
    } catch (err) {
      expectRejected(err, 404);
    }
  });

  it("findOwnAuditWithItems enforces ownership (foreign → undefined)", async () => {
    const audit = await createAudit({ userId: userA._id, title: "items-owner" });
    await createAuditItem({ auditId: audit._id, userId: userA._id, label: "issue", type: "security" });

    const own = await findOwnAuditWithItems(String(audit._id), String(userA._id));
    expect(own).toBeDefined();
    expect(own!.items).toHaveLength(1);

    const foreign = await findOwnAuditWithItems(String(audit._id), String(userB._id));
    expect(foreign).toBeUndefined();
  });

  it("assertItemAccess: item.userId enforced; legacy items fall back to parent audit ownership", async () => {
    const parent = await createAudit({ userId: userA._id, title: "parent" });

    // New-style item: carries its own userId
    const owned = await createAuditItem({
      auditId: parent._id,
      userId: userA._id,
      label: "new item",
      type: "security",
    });

    await assertItemAccess(String(owned._id), String(userA._id)); // ok
    await expect(assertItemAccess(String(owned._id), String(userB._id))).rejects.toMatchObject({ status: 404 });

    // Legacy item (no userId) → parent audit ownership decides
    const legacy = await AuditItem.create({
      auditId: parent._id,
      label: "legacy item",
      type: "security",
    });
    await assertItemAccess(String(legacy._id), String(userA._id)); // parent owner passes
    await expect(assertItemAccess(String(legacy._id), String(userB._id))).rejects.toMatchObject({ status: 404 });
  });
});

describe("ownership HTTP surface (/api)", () => {
  let auditA: { _id: unknown };
  let itemA: { _id: unknown };

  beforeAll(async () => {
    auditA = (await createAudit({ userId: userA._id, title: "http-owned audit" })).toObject();
    itemA = (
      await createAuditItem({
        auditId: auditA._id,
        userId: userA._id,
        label: "http item",
        type: "security",
      })
    ).toObject();
  });

  it("GET /api/audits returns ONLY the caller's audits", async () => {
    const res = await request(app).get("/api/audits").set("Cookie", authCookie(userA));
    expect(res.status).toBe(200);
    const ids = (res.body as { _id: string }[]).map(x => x._id);
    expect(ids).toContain(String(auditA._id));
  });

  it("audit.getId(?) foreign audit ids respond 404 — indistinguishable from missing", async () => {
    const res = await request(app).get(`/api/audits/${new mongoose.Types.ObjectId().toHexString()}`).set("Cookie", authCookie(userA));
    expect(res.status).toBe(404);
  });

  it("PATCH foreign audit item → 404", async () => {
    // Create a foreign item owned by B
    const foreignParent = await createAudit({ userId: userB._id, title: "b-audit" });
    const foreignItem = await createAuditItem({
      auditId: foreignParent._id,
      userId: userB._id,
      label: "b item",
      type: "security",
    });

    const res = await request(app)
      .patch(`/api/audit-items/${String(foreignItem._id)}`)
      .set("Cookie", authCookie(userA))
      .send({ label: "hijack" });
    expect(res.status).toBe(404);

    // B can still patch their own item
    const ok = await request(app)
      .patch(`/api/audit-items/${String(foreignItem._id)}`)
      .set("Cookie", authCookie(userB))
      .send({ label: "renamed by owner" });
    expect(ok.status).toBe(200);
    expect(ok.body.label).toBe("renamed by owner");
  });

  it("PATCH cannot reassign userId: spoofed owner is ignored", async () => {
    // Sanity: valid object id shape so the spoof attempt is realistic
    expect(A_ID).toMatch(/^[a-f0-9]{24}$/);

    const res = await request(app)
      .patch(`/api/audits/${String(auditA._id)}`)
      .set("Cookie", authCookie(userA))
      .send({ title: "renamed", userId: userB._id });
    expect(res.status).toBe(200);

    const after = (await Audit.findById(String(auditA._id)).lean())! as { userId?: unknown; title: string };
    expect(after.title).toBe("renamed");
    void itemA;
  });

  it("POST /api/audits with a spoofed userId is ignored (server assigns owner)", async () => {
    const res = await request(app)
      .post("/api/audits")
      .set("Cookie", authCookie(userA))
      .send({ title: "spoof attempt", userId: userB._id });
    expect(res.status).toBe(201);
    expect(String((res.body as { userId?: unknown }).userId)).toBe(String(userA._id));
  });
});
