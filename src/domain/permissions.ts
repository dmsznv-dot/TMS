export const ROLES = ["admin", "logist", "warehouse", "finance", "manager"] as const;
export type Role = (typeof ROLES)[number];

export type Action =
  | "settings.manage"
  | "refs.read"
  | "refs.write"
  | "trips.read"
  | "planning.write"
  | "routing.calculate"
  | "execution.write"
  | "money.read"
  | "money.write"
  | "trip.close"
  | "export.run";

const ALLOWED: Record<Action, readonly Role[]> = {
  "settings.manage": ["admin"],
  "refs.read": ROLES,
  "trips.read": ROLES,
  "export.run": ROLES,
  "refs.write": ["admin", "logist"],
  "planning.write": ["admin", "logist"],
  "routing.calculate": ["admin", "logist"],
  "execution.write": ["admin", "logist", "warehouse"],
  "money.read": ["admin", "logist", "finance", "manager"],
  "money.write": ["admin", "logist", "finance"],
  "trip.close": ["admin", "finance"],
};

export function can(role: Role, action: Action): boolean {
  return ALLOWED[action].includes(role);
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Администратор",
  logist: "Логист",
  warehouse: "Склад",
  finance: "Финансы",
  manager: "Руководитель",
};
