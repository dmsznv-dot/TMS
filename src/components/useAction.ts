"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type Result = { ok: boolean; message?: string };

/** Runs a server action, refreshes the page when it succeeds and keeps the message when it fails. */
export function useAction() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(fn: () => Promise<Result>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) return setError(result.message ?? "Не удалось выполнить действие");
      after?.();
      router.refresh();
    });
  }
  return { error, pending, run, setError };
}
