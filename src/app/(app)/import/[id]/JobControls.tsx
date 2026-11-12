"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { applyImportAction, fixImportRowAction, importStatusAction } from "@/app/actions/import";
import { Button, ErrorText, inputClass } from "@/components/ui";
import type { RowError } from "@/domain/importMapping";

/** Starts processing and refreshes the page until the job leaves the queue. */
export function ApplyButton({ jobId, busy, label }: { jobId: string; busy: boolean; label: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(async () => {
      const result = await importStatusAction(jobId);
      if (result.ok && result.data.status !== "queued" && result.data.status !== "processing") {
        router.refresh();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [busy, jobId, router]);

  function apply() {
    setError(null);
    startTransition(async () => {
      const result = await applyImportAction(jobId);
      if (!result.ok) setError(result.message);
      else router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      <ErrorText>{error}</ErrorText>
      {busy ? (
        <p className="text-gray-600" aria-live="polite">
          Обработка… Страница обновится сама.
        </p>
      ) : (
        <Button onClick={apply} disabled={pending}>
          {label}
        </Button>
      )}
    </div>
  );
}

type RowProps = {
  jobId: string;
  rowId: string;
  rowNo: number;
  /** Mapped column headers, in file order. */
  headers: string[];
  values: Record<string, string>;
  errors: RowError[];
  editable: boolean;
};

export function ErrorRow({ jobId, rowId, rowNo, headers, values: initial, errors: initialErrors, editable }: RowProps) {
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState(initialErrors);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function process() {
    setFailure(null);
    startTransition(async () => {
      const result = await fixImportRowAction(jobId, rowId, values);
      if (!result.ok) return setFailure(result.message);
      setErrors(result.data.errors);
      router.refresh();
    });
  }

  return (
    <div data-testid="error-row" className="space-y-2 border-b border-gray-100 p-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-medium">Строка {rowNo}</span>
        {errors.map((e, i) => (
          <span key={i} className="text-red-700">
            {e.message}
          </span>
        ))}
      </div>
      {editable && (
        <>
          <div className="grid gap-2 md:grid-cols-3 lg:grid-cols-4">
            {headers.map((header) => (
              <label key={header} className="block">
                <span className="mb-0.5 block text-xs text-gray-500">{header}</span>
                <input
                  className={inputClass}
                  value={values[header] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [header]: e.target.value }))}
                />
              </label>
            ))}
          </div>
          <ErrorText>{failure}</ErrorText>
          <Button variant="secondary" onClick={process} disabled={pending}>
            Обработать строку
          </Button>
        </>
      )}
    </div>
  );
}
