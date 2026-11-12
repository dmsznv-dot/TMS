import { describe, expect, it } from "vitest";
import { can, type Action, type Role } from "./permissions";

const ALL: Role[] = ["admin", "logist", "warehouse", "finance", "manager"];

const MATRIX: [Action, Role[]][] = [
  ["settings.manage", ["admin"]],
  ["refs.read", ALL],
  ["trips.read", ALL],
  ["export.run", ALL],
  ["refs.write", ["admin", "logist"]],
  ["planning.write", ["admin", "logist"]],
  ["routing.calculate", ["admin", "logist"]],
  ["execution.write", ["admin", "logist", "warehouse"]],
  ["money.read", ["admin", "logist", "finance", "manager"]],
  ["money.write", ["admin", "logist", "finance"]],
  ["trip.close", ["admin", "finance"]],
];

describe("can", () => {
  it.each(MATRIX)("%s is allowed exactly for the listed roles", (action, allowed) => {
    for (const role of ALL) {
      expect(can(role, action), `${role} / ${action}`).toBe(allowed.includes(role));
    }
  });
});
