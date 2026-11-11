import { randomBytes } from "node:crypto";
import type { Role } from "@/domain/permissions";
import type { Ctx } from "@/server/auth/context";
import type { Db } from "@/server/db/client";
import { createOrganization, createUser } from "@/server/services/users";

const unique = () => randomBytes(4).toString("hex");

export type TestOrg = {
  orgId: string;
  adminUserId: string;
  /** A context for a new user of the given role in this organization. */
  as(role: Role): Promise<Ctx>;
};

export async function makeOrg(db: Db, name = `Org ${unique()}`): Promise<TestOrg> {
  const { orgId, userId } = await createOrganization(db, {
    orgName: name,
    adminEmail: `admin-${unique()}@example.test`,
    adminPassword: "password-123",
    adminName: "Admin",
  });
  const adminCtx: Ctx = { db, orgId, actor: { kind: "user", userId, role: "admin" } };
  return {
    orgId,
    adminUserId: userId,
    async as(role) {
      if (role === "admin") return adminCtx;
      const created = await createUser(adminCtx, {
        email: `${role}-${unique()}@example.test`,
        name: role,
        role,
        password: "password-123",
      });
      return { db, orgId, actor: { kind: "user", userId: created.userId, role } };
    },
  };
}
