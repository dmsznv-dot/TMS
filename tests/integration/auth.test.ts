import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DomainError } from "@/domain/errors";
import { ctxFromSessionToken, login, logout } from "@/server/auth/session";
import type { Db } from "@/server/db/client";
import { auditLog, sessions } from "@/server/db/schema";
import {
  createOrganization,
  createUser,
  getOrgSettings,
  listUsers,
  setUserActive,
  updateOrgSettings,
} from "@/server/services/users";
import { makeOrg } from "../helpers/factories";
import { withTestDb } from "../helpers/testDb";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await withTestDb());
});
afterAll(async () => {
  await close();
});

async function expectCode(p: Promise<unknown>, code: string) {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(code);
}

describe("login", () => {
  it("logs in with the correct password only", async () => {
    await createOrganization(db, {
      orgName: "Login Org",
      adminEmail: "Boss@Example.test",
      adminPassword: "correct-horse",
      adminName: "Boss",
    });
    expect(await login(db, "boss@example.test", "wrong-password")).toBeNull();
    expect(await login(db, "nobody@example.test", "correct-horse")).toBeNull();

    const session = await login(db, "BOSS@example.test", "correct-horse");
    expect(session?.token).toBeTruthy();

    const ctx = await ctxFromSessionToken(db, session!.token);
    expect(ctx?.actor).toMatchObject({ kind: "user", role: "admin" });
  });

  it("rejects an inactive user and drops their sessions", async () => {
    const org = await makeOrg(db);
    const admin = await org.as("admin");
    const { userId } = await createUser(admin, {
      email: "sleepy@example.test",
      name: "Sleepy",
      role: "logist",
      password: "password-123",
    });
    const session = await login(db, "sleepy@example.test", "password-123");
    expect(session).not.toBeNull();

    await setUserActive(admin, { userId, active: false });

    expect(await login(db, "sleepy@example.test", "password-123")).toBeNull();
    expect(await ctxFromSessionToken(db, session!.token)).toBeNull();
  });

  it("expires sessions", async () => {
    await createOrganization(db, {
      orgName: "Expiry Org",
      adminEmail: "expiry@example.test",
      adminPassword: "password-123",
      adminName: "E",
    });
    const session = await login(db, "expiry@example.test", "password-123");
    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await ctxFromSessionToken(db, session!.token)).toBeNull();
  });

  it("logout invalidates the token", async () => {
    await createOrganization(db, {
      orgName: "Logout Org",
      adminEmail: "logout@example.test",
      adminPassword: "password-123",
      adminName: "L",
    });
    const session = await login(db, "logout@example.test", "password-123");
    await logout(db, session!.token);
    expect(await ctxFromSessionToken(db, session!.token)).toBeNull();
  });

  it("stores only a hash of the session token", async () => {
    await createOrganization(db, {
      orgName: "Hash Org",
      adminEmail: "hash@example.test",
      adminPassword: "password-123",
      adminName: "H",
    });
    const session = await login(db, "hash@example.test", "password-123");
    const rows = await db.select().from(sessions);
    expect(rows.some((r) => r.tokenHash === session!.token)).toBe(false);
  });
});

describe("users", () => {
  it("non-admin cannot create users", async () => {
    const org = await makeOrg(db);
    const logist = await org.as("logist");
    await expectCode(
      createUser(logist, { email: "x@example.test", name: "X", role: "finance", password: "password-123" }),
      "forbidden",
    );
  });

  it("rejects a duplicate email", async () => {
    const org = await makeOrg(db);
    const admin = await org.as("admin");
    await createUser(admin, { email: "dup@example.test", name: "A", role: "logist", password: "password-123" });
    await expectCode(
      createUser(admin, { email: "DUP@example.test", name: "B", role: "logist", password: "password-123" }),
      "email_taken",
    );
  });

  it("rejects a short password", async () => {
    const org = await makeOrg(db);
    await expectCode(
      createUser(await org.as("admin"), { email: "short@example.test", name: "S", role: "logist", password: "123" }),
      "validation",
    );
  });

  it("listUsers returns only the caller's organization", async () => {
    const a = await makeOrg(db);
    const b = await makeOrg(db);
    await a.as("logist");
    await b.as("finance");

    const usersOfA = await listUsers(await a.as("admin"));
    expect(usersOfA.map((u) => u.role).sort()).toEqual(["admin", "logist"]);
    expect(usersOfA.every((u) => !("passwordHash" in u))).toBe(true);
  });

  it("cannot deactivate a user of another organization", async () => {
    const a = await makeOrg(db);
    const b = await makeOrg(db);
    await expectCode(
      setUserActive(await a.as("admin"), { userId: b.adminUserId, active: false }),
      "not_found",
    );
  });

  it("writes an audit entry for user creation", async () => {
    const org = await makeOrg(db);
    const admin = await org.as("admin");
    const { userId } = await createUser(admin, {
      email: "audited@example.test",
      name: "Audited",
      role: "warehouse",
      password: "password-123",
    });
    const entries = await db.select().from(auditLog).where(eq(auditLog.entityId, userId));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ orgId: org.orgId, entity: "user", action: "create" });
    expect(JSON.stringify(entries[0].after)).not.toContain("password");
  });
});

describe("organization settings", () => {
  it("starts with VAT 22 % and a 15 minute window buffer", async () => {
    const org = await makeOrg(db);
    const settings = await getOrgSettings(await org.as("manager"));
    expect(settings).toMatchObject({ vatRateBp: 2200, windowBufferMin: 15 });
  });

  it("only an admin changes settings", async () => {
    const org = await makeOrg(db);
    await expectCode(updateOrgSettings(await org.as("finance"), { vatRateBp: 2000 }), "forbidden");

    await updateOrgSettings(await org.as("admin"), { vatRateBp: 2000, fleetRule: "km" });
    expect(await getOrgSettings(await org.as("admin"))).toMatchObject({ vatRateBp: 2000, fleetRule: "km" });
  });

  it("does not leak settings changes into another organization", async () => {
    const a = await makeOrg(db);
    const b = await makeOrg(db);
    await updateOrgSettings(await a.as("admin"), { windowBufferMin: 45 });
    expect((await getOrgSettings(await b.as("admin"))).windowBufferMin).toBe(15);
  });
});
