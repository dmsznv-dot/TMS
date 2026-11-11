"use client";

import { useState } from "react";
import { addDocumentAction, setDocumentStatusAction } from "@/app/actions/finance";
import { Button, ErrorText, inputClass, inputInlineClass } from "@/components/ui";
import { useAction } from "@/components/useAction";
import type { DocumentStatus } from "@/server/db/schema";

export const DOCUMENT_STATUSES: { value: DocumentStatus; label: string }[] = [
  { value: "draft", label: "Черновик" },
  { value: "sent", label: "Отправлен" },
  { value: "signed", label: "Подписан" },
  { value: "rejected", label: "Отклонён" },
];

export function DocumentForm({ tripId }: { tripId: string }) {
  const { error, pending, run } = useAction();
  const [kind, setKind] = useState("");
  const [number, setNumber] = useState("");
  const [ref, setRef] = useState("");
  const [status, setStatus] = useState<DocumentStatus>("draft");

  function add() {
    run(
      () => addDocumentAction(tripId, { kind, number: number.trim() || undefined, operatorRef: ref.trim() || undefined, status }),
      () => {
        setKind("");
        setNumber("");
        setRef("");
      },
    );
  }
  const label = "mb-1 block text-xs text-gray-500";
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-4">
        <label className="block">
          <span className={label}>Вид</span>
          <input aria-label="Вид документа" className={inputClass} placeholder="ЭПД, ТН, акт" value={kind} onChange={(e) => setKind(e.target.value)} />
        </label>
        <label className="block">
          <span className={label}>Номер</span>
          <input aria-label="Номер документа" className={inputClass} value={number} onChange={(e) => setNumber(e.target.value)} />
        </label>
        <label className="block">
          <span className={label}>Ссылка или идентификатор у оператора</span>
          <input aria-label="Ссылка или идентификатор у оператора" className={inputClass} value={ref} onChange={(e) => setRef(e.target.value)} />
        </label>
        <label className="block">
          <span className={label}>Статус</span>
          <select aria-label="Начальный статус" className={inputClass} value={status} onChange={(e) => setStatus(e.target.value as DocumentStatus)}>
            {DOCUMENT_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorText>{error}</ErrorText>
      <Button variant="secondary" disabled={pending} onClick={add}>
        Добавить документ
      </Button>
    </div>
  );
}

export function DocumentStatusSelect({ tripId, documentId, status }: { tripId: string; documentId: string; status: DocumentStatus }) {
  const { error, pending, run } = useAction();
  return (
    <div>
      <select
        aria-label="Статус документа"
        className={`${inputInlineClass} w-auto`}
        value={status}
        disabled={pending}
        onChange={(e) => run(() => setDocumentStatusAction(tripId, documentId, e.target.value as DocumentStatus))}
      >
        {DOCUMENT_STATUSES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
}
