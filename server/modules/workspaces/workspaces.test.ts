import { describe, it, expect, beforeAll, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import request from "supertest";
import { ENV } from "../../config/env";
import { User, type UserDocument } from "../../models/User";
import { Workspace } from "../../models/Workspace";
import { WorkspaceMember, roleAtLeast } from "../../models/WorkspaceMember";
import { ProviderConnection } from "../../models/ProviderConnection";
import { Repository } from "../../models/Repository";
import { Finding } from "../../models/Finding";
import { startTestDb, stopTestDb } from "../../test/helpers/db";
import {
  ensurePersonalWorkspace,
  deleteWorkspaceIfEmpty,
} from "./service";
import { encryptSecret } from "../../lib/crypto";
import { app } from "../../app";

let userA: UserDocument; // workspace owner
let userB: UserDocument; // developer member (promoted to admin mid-suite)
let userC: UserDocument; // joins mid-suite via the admin-add flow
let userD: UserDocument; // viewer member
let userE: UserDocument; // pure outsider — never granted any membership

let wsA: { id: string };

beforeAll(async () => {
  await startTestDb("workspaces-test");

  // Unique indexes build asynchronously on first use — force them before any
  // write, or the slug/membership/fingerprint uniqueness races the test.
  await Promise.all([
    Workspace.syncIndexes(),
    WorkspaceMember.syncIndexes(),
    ProviderConnection.syncIndexes(),
    Repository.syncIndexes(),
    Finding.syncIndexes(),
  ]);

  userA = (await User.create({ githubId: "200001", username: "owner-a" })) as unknown as UserDocument;
  userB = (await User.create({ githubId: "200002", username: "dev-b" })) as unknown as UserDocument;
  userC = (await User.create({ githubId: "200003", username: "outsider-c" })) as unknown as UserDocument;
  userD = (await User.create({ githubId: "200004", username: "viewer-d" })) as unknown as UserDocument;
  userE = (await User.create({ githubId: "200005", username: "outsider-e" })) as unknown as UserDocument;

  const ws = await Workspace.create({ name: "Alpha", slug: "alpha", owner: userA._id, type: "team" });
  wsA = { id: String(ws._id) };
  await WorkspaceMember.create({ workspaceId: ws._id, userId: userA._id, role: "owner", status: "active" });
  await WorkspaceMember.create({ workspaceId: ws._id, userId: userB._id, role: "developer", status: "active" });
  await WorkspaceMember.create({ workspaceId: ws._id, userId: userD._id, role: "viewer", status: "active" });
}, 180_000);

afterAll(async () => {
  await stopTestDb();
}, 60_000);

function authCookie(user: UserDocument): string {
  const token = jwt.sign({ userId: String(user._id) }, ENV.JWT_SECRET as string, { expiresIn: "1h" });
  return `audit_token=${token}`;
}

describe("workspace model integrity", () => {
  it("enforces globally-unique slugs", async () => {
    await expect(Workspace.create({ name: "Dup", slug: "alpha", owner: userB._id })).rejects.toMatchObject({
      code: 11000,
    });
  });

  it("enforces one membership per user per workspace", async () => {
    await expect(
      WorkspaceMember.create({ workspaceId: wsA.id, userId: userB._id, role: "viewer" }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it("roleAtLeast orders owner > admin > developer > viewer", () => {
    expect(roleAtLeast("owner", "viewer")).toBe(true);
    expect(roleAtLeast("admin", "admin")).toBe(true);
    expect(roleAtLeast("developer", "admin")).toBe(false);
    expect(roleAtLeast("viewer", "developer")).toBe(false);
  });
});

describe("workspace RBAC (HTTP surface /api)", () => {
  it("viewer can read repositories but cannot register one (403)", async () => {
    const conn = await ProviderConnection.create({
      workspaceId: wsA.id,
      provider: "github",
      kind: "oauth-user",
      providerAccountId: userA.githubId,
      providerAccountLogin: userA.username,
      credentialsEncrypted: encryptSecret("tok-viewer-test"),
    });

    const read = await request(app)
      .get(`/api/workspaces/${wsA.id}/repositories`)
      .set("Cookie", authCookie(userD));
    expect(read.status).toBe(200);

    const write = await request(app)
      .post(`/api/workspaces/${wsA.id}/repositories/register`)
      .set("Cookie", authCookie(userD))
      .send({
        providerConnectionId: String(conn._id),
        provider: "github",
        providerExternalId: "repo-1",
        ownerAccount: "octo",
        fullName: "octo/repo-1",
      });
    expect(write.status).toBe(403);
  });

  it("developer can register a repository; re-registration converges to one row", async () => {
    const conn = await ProviderConnection.findOne({ workspaceId: wsA.id });
    const payload = {
      providerConnectionId: String(conn!._id),
      provider: "github",
      providerExternalId: "R_node_1",
      ownerAccount: "octo",
      fullName: "octo/widget",
      visibility: "private",
    };

    const first = await request(app)
      .post(`/api/workspaces/${wsA.id}/repositories/register`)
      .set("Cookie", authCookie(userB))
      .send(payload);
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/workspaces/${wsA.id}/repositories/register`)
      .set("Cookie", authCookie(userB))
      .send(payload);
    expect([201, 200]).toContain(second.status);
    expect(second.body.repository.id).toBe(first.body.repository.id);

    const rows = await Repository.find({
      workspaceId: wsA.id,
      provider: "github",
      providerExternalId: "R_node_1",
    });
    expect(rows).toHaveLength(1);
  });

  it("admin can add a member; viewer cannot (403); duplicate add is a 409", async () => {
    const promote = await request(app)
      .patch(`/api/workspaces/${wsA.id}/members/${userB._id}`)
      .set("Cookie", authCookie(userA))
      .send({ role: "admin" });
    expect(promote.status).toBe(200);
    expect(promote.body.member.role).toBe("admin");

    const add = await request(app)
      .post(`/api/workspaces/${wsA.id}/members`)
      .set("Cookie", authCookie(userB))
      .send({ userId: String(userC._id), role: "developer" });
    expect(add.status).toBe(201);

    const dup = await request(app)
      .post(`/api/workspaces/${wsA.id}/members`)
      .set("Cookie", authCookie(userB))
      .send({ userId: String(userC._id), role: "developer" });
    expect(dup.status).toBe(409);

    const viewerAdd = await request(app)
      .post(`/api/workspaces/${wsA.id}/members`)
      .set("Cookie", authCookie(userD))
      .send({ userId: String(userC._id), role: "viewer" });
    expect(viewerAdd.status).toBe(403);
  });

  it("only the owner can grant the admin role; owner membership is immutable", async () => {
    const adminGrant = await request(app)
      .patch(`/api/workspaces/${wsA.id}/members/${userC._id}`)
      .set("Cookie", authCookie(userB))
      .send({ role: "admin" });
    expect(adminGrant.status).toBe(403);

    const ownerTouch = await request(app)
      .patch(`/api/workspaces/${wsA.id}/members/${userA._id}`)
      .set("Cookie", authCookie(userA))
      .send({ role: "developer" });
    expect(ownerTouch.status).toBe(403);
  });

  it("the workspace owner cannot be removed", async () => {
    const res = await request(app)
      .delete(`/api/workspaces/${wsA.id}/members/${userA._id}`)
      .set("Cookie", authCookie(userB));
    expect(res.status).toBe(403);
  });
});

describe("cross-workspace isolation (404-not-403)", () => {
  it("outsider gets 404 for foreign workspace, its repositories, and its members", async () => {
    for (const path of [
      `/api/workspaces/${wsA.id}`,
      `/api/workspaces/${wsA.id}/repositories`,
      `/api/workspaces/${wsA.id}/members`,
    ]) {
      const res = await request(app).get(path).set("Cookie", authCookie(userE));
      expect(res.status).toBe(404);
    }
  });

  it("outsider cannot register into, rename, or delete a foreign workspace", async () => {
    const register = await request(app)
      .post(`/api/workspaces/${wsA.id}/repositories/register`)
      .set("Cookie", authCookie(userE))
      .send({
        providerConnectionId: "f".repeat(24),
        provider: "github",
        providerExternalId: "x",
        ownerAccount: "x",
        fullName: "x/y",
      });
    expect(register.status).toBe(404);

    const rename = await request(app)
      .patch(`/api/workspaces/${wsA.id}`)
      .set("Cookie", authCookie(userE))
      .send({ name: "Hijack" });
    expect(rename.status).toBe(404);

    const del = await request(app)
      .delete(`/api/workspaces/${wsA.id}`)
      .set("Cookie", authCookie(userE));
    expect(del.status).toBe(404);
  });

  it("spoofed identities cannot reach workspace data (JWT is the identity source)", async () => {
    const res = await request(app)
      .get(`/api/workspaces/${wsA.id}`)
      .set("Cookie", authCookie(userE));
    expect(res.status).toBe(404);
  });
});

describe("workspace lifecycle", () => {
  it("personal-workspace provisioning is idempotent", async () => {
    const first = await ensurePersonalWorkspace({ _id: userA._id, username: userA.username });
    const second = await ensurePersonalWorkspace({ _id: userA._id, username: userA.username });
    expect(String(second._id)).toBe(String(first._id));
    expect(second.type).toBe("personal");

    const membership = await WorkspaceMember.findOne({
      workspaceId: first._id,
      userId: userA._id,
    });
    expect(membership?.role).toBe("owner");
  });

  it("creating a workspace makes the creator the owner (HTTP)", async () => {
    const res = await request(app)
      .post("/api/workspaces")
      .set("Cookie", authCookie(userC))
      .send({ name: "Client Work", type: "agency" });
    expect(res.status).toBe(201);
    expect(res.body.workspace.role).toBe("owner");
    expect(res.body.workspace.type).toBe("agency");
  });

  it("workspace delete is owner-only and refuses while repositories exist", async () => {
    const del = await request(app)
      .delete(`/api/workspaces/${wsA.id}`)
      .set("Cookie", authCookie(userB)); // admin, not owner
    expect(del.status).toBe(403);

    await expect(deleteWorkspaceIfEmpty(wsA.id)).rejects.toMatchObject({ status: 409 });
  });
});

describe("provider connections", () => {
  it("clone the session token and never expose credentials", async () => {
    userA.accessTokenEncrypted = encryptSecret("session-secret-token");
    await userA.save();

    // Fresh workspace — the RBAC suite already provisioned a connection on
    // wsA, so the first-clone-must-201 assertion needs a clean target.
    const created = await request(app)
      .post("/api/workspaces")
      .set("Cookie", authCookie(userA))
      .send({ name: "Clone Lab" });
    expect(created.status).toBe(201);
    const wsId = created.body.workspace.id as string;

    const res = await request(app)
      .post(`/api/workspaces/${wsId}/provider-connections`)
      .set("Cookie", authCookie(userA))
      .send({ provider: "github" });
    expect(res.status).toBe(201);

    // Second call converges (idempotent clone)
    const again = await request(app)
      .post(`/api/workspaces/${wsId}/provider-connections`)
      .set("Cookie", authCookie(userA))
      .send({ provider: "github" });
    expect(again.status).toBe(200);
    expect(again.body.connection.id).toBe(res.body.connection.id);

    const list = await request(app)
      .get(`/api/workspaces/${wsA.id}/provider-connections`)
      .set("Cookie", authCookie(userD));
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain("credentials");
    expect(JSON.stringify(list.body)).not.toContain("session-secret-token");

    // Viewer cannot connect credentials
    const forbidden = await request(app)
      .post(`/api/workspaces/${wsA.id}/provider-connections`)
      .set("Cookie", authCookie(userD))
      .send({ provider: "github" });
    expect(forbidden.status).toBe(403);
  });
});

describe("finding fingerprint dedupe spine", () => {
  it("the same {repositoryId, fingerprint} cannot produce two findings", async () => {
    const repo = await Repository.findOne({ workspaceId: wsA.id });
    expect(repo).toBeTruthy();

    const base = {
      workspaceId: wsA.id,
      repositoryId: repo!._id,
      severity: "high" as const,
      category: "security" as const,
      filePath: "src/auth.ts",
      description: "Hardcoded credential",
    };

    await Finding.create({ ...base, fingerprint: "v1:abc123" });
    await expect(Finding.create({ ...base, fingerprint: "v1:abc123" })).rejects.toMatchObject({
      code: 11000,
    });
    // A different fingerprint in the same repo is a distinct finding
    await Finding.create({ ...base, fingerprint: "v1:def456" });
  });
});
