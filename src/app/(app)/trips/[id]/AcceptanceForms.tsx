"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { completeTaskAction, recordAcceptanceAction } from "@/app/actions/execution";
import { Button, ErrorText, inputClass } from "@/components/ui";
import { formatQty, parseQty } from "@/domain/qty";
import { zonedToUtc } from "@/domain/time";
import type { ReasonCode } from "@/server/db/schema";

const REASONS: { value: ReasonCode; label: string }[] = [
  { value: "shortage", label: "Недостача" },
  { value: "damage", label: "Повреждение" },
  { value: "quality", label: "Качество" },
  { value: "docs_mismatch", label: "Расхождение в документах" },
  { value: "refused", label: "Отказ получателя" },
  { value: "other", label: "Другое" },
];

type Person = { id: string; name: string };

export type AcceptanceRowProps = {
  tripId: string;
  tz: string;
  cargoId: string;
  baseMilli: number;
  unit: string | null;
  people: Person[];
  current: { versionNo: number; acceptedMilli: number; rejectedMilli: number; returnedMilli: number; reasonCode: ReasonCode | null; confirmation: string | null } | null;
  canEdit: boolean;
};

/** The form for one cargo row. A saved acceptance becomes the next version. */
export function AcceptanceForm({ tripId, tz, cargoId, baseMilli, unit, people, current, canEdit }: AcceptanceRowProps) {
  const router = useRouter();
  const [accepted, setAccepted] = useState(formatQty(current?.acceptedMilli ?? baseMilli));
  const [rejected, setRejected] = useState(formatQty(current?.rejectedMilli ?? 0));
  const [returned, setReturned] = useState(formatQty(current?.returnedMilli ?? 0));
  const [reason, setReason] = useState<string>(current?.reasonCode ?? "");
  const [confirmation, setConfirmation] = useState(current?.confirmation ?? "");
  const [responsible, setResponsible] = useState("");
  const [due, setDue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    setError(null);
    const a = parseQty(accepted);
    const r = parseQty(rejected);
    const ret = parseQty(returned);
    if (a == null || r == null || ret == null) return setError("Количества — числа не меньше нуля");
    startTransition(async () => {
      const result = await recordAcceptanceAction(tripId, {
        tripCargoId: cargoId,
        acceptedMilli: a,
        rejectedMilli: r,
        returnedMilli: ret,
        reasonCode: (reason || undefined) as ReasonCode | undefined,
        confirmation: confirmation.trim() || undefined,
        responsibleUserId: responsible || undefined,
        dueAt: due ? zonedToUtc(`${due}T18:00`, tz) : undefined,
      });
      if (!result.ok) return setError(result.message);
      router.refresh();
    });
  }

  const field = "block";
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-3">
        <label className={field}>
          <span className="mb-1 block text-xs text-gray-500">Принято{unit ? `, ${unit}` : ""}</span>
          <input aria-label="Принято" className={inputClass} inputMode="decimal" disabled={!canEdit} value={accepted} onChange={(e) => setAccepted(e.target.value)} />
        </label>
        <label className={field}>
          <span className="mb-1 block text-xs text-gray-500">Отклонено</span>
          <input aria-label="Отклонено" className={inputClass} inputMode="decimal" disabled={!canEdit} value={rejected} onChange={(e) => setRejected(e.target.value)} />
        </label>
        <label className={field}>
          <span className="mb-1 block text-xs text-gray-500">Возвращено</span>
          <input aria-label="Возвращено" className={inputClass} inputMode="decimal" disabled={!canEdit} value={returned} onChange={(e) => setReturned(e.target.value)} />
        </label>
        <label className={field}>
          <span className="mb-1 block text-xs text-gray-500">Причина</span>
          <select aria-label="Причина" className={inputClass} disabled={!canEdit} value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">— нет —</option>
            {REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label className={`${field} md:col-span-2`}>
          <span className="mb-1 block text-xs text-gray-500">Подтверждение</span>
          <input aria-label="Подтверждение" className={inputClass} disabled={!canEdit} placeholder="Номер акта, подпись, сообщение" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
        </label>
      </div>

      {canEdit && (
        <details className="text-xs">
          <summary className="cursor-pointer text-gray-600">Ответственный и срок задачи при недопоставке</summary>
          <div className="mt-2 grid gap-3 md:grid-cols-2">
            <label className="block">
              <span className="mb-1 block">Ответственный</span>
              <select aria-label="Ответственный" className={inputClass} value={responsible} onChange={(e) => setResponsible(e.target.value)}>
                <option value="">Я</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block">Срок</span>
              <input aria-label="Срок" type="date" className={inputClass} value={due} onChange={(e) => setDue(e.target.value)} />
            </label>
          </div>
        </details>
      )}

      <ErrorText>{error}</ErrorText>
      {canEdit && (
        <Button variant="secondary" onClick={save} disabled={pending}>
          Сохранить приёмку
        </Button>
      )}
    </div>
  );
}

export function CompleteTaskForm({ tripId, taskId }: { tripId: string; taskId: string }) {
  const router = useRouter();
  const [resolution, setResolution] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function complete() {
    setError(null);
    startTransition(async () => {
      const result = await completeTaskAction(tripId, taskId, resolution);
      if (!result.ok) return setError(result.message);
      router.refresh();
    });
  }

  return (
    <div className="mt-2 space-y-2">
      <div className="flex gap-2">
        <input aria-label="Как решена задача" className={inputClass} placeholder="Как решена" value={resolution} onChange={(e) => setResolution(e.target.value)} />
        <Button variant="secondary" disabled={pending} onClick={complete}>
          Закрыть задачу
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
