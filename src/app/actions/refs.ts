"use server";

import { DomainError } from "@/domain/errors";
import { isRefKind, REF_CONFIG } from "../(app)/refs/config";
import { run, type ActionResult } from "./run";

function configOf(kind: string) {
  if (!isRefKind(kind)) throw new DomainError("not_found", "Неизвестный справочник");
  return REF_CONFIG[kind];
}

export async function saveRefAction(
  kind: string,
  id: string | null,
  data: Record<string, unknown>,
): Promise<ActionResult<{ id: string }>> {
  return run(
    async (ctx) => {
      const config = configOf(kind);
      if (id) {
        await config.update(ctx, id, data);
        return { id };
      }
      return config.create(ctx, data);
    },
    [`/refs/${kind}`],
  );
}

export async function setRefActiveAction(kind: string, id: string, active: boolean): Promise<ActionResult> {
  return run(async (ctx) => configOf(kind).setActive(ctx, id, active), [`/refs/${kind}`]);
}
