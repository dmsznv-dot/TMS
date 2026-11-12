import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { isDomainError } from "@/domain/errors";
import { requireCtx, type UserCtx } from "@/server/auth/requireCtx";

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string; fields?: Record<string, string> };

type Issue = { path: PropertyKey[]; message: string };

function fieldErrors(details: unknown): Record<string, string> | undefined {
  if (!Array.isArray(details)) return undefined;
  const fields: Record<string, string> = {};
  for (const issue of details as Issue[]) {
    const key = issue.path?.map(String).join(".");
    if (key && !(key in fields)) fields[key] = issue.message;
  }
  return Object.keys(fields).length > 0 ? fields : undefined;
}

/**
 * Runs a service call for the signed-in user and turns expected failures
 * into a result the form can show. Paths listed in `revalidate` are
 * re-rendered after a successful call.
 */
export async function run<T>(
  fn: (ctx: UserCtx) => Promise<T>,
  revalidate: string[] = [],
): Promise<ActionResult<T>> {
  try {
    const ctx = await requireCtx();
    const data = await fn(ctx);
    for (const path of revalidate) revalidatePath(path);
    return { ok: true, data };
  } catch (e) {
    unstable_rethrow(e);
    if (isDomainError(e)) {
      return { ok: false, code: e.code, message: e.message, fields: fieldErrors(e.details) };
    }
    console.error("Unexpected error in action", e instanceof Error ? e.message : e);
    return { ok: false, code: "internal", message: "Внутренняя ошибка. Повторите действие." };
  }
}
