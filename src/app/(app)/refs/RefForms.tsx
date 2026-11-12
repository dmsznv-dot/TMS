"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveRefAction, setRefActiveAction } from "@/app/actions/refs";
import { EntityForm, type FieldSpec } from "@/components/EntityForm";
import { Button, Card, ErrorText } from "@/components/ui";

type FormProps = {
  kind: string;
  fields: FieldSpec[];
  map?: { latField: string; lonField: string; tileUrl: string };
};

/** The "Добавить" button with a form that opens under it. */
export function AddRefPanel({ kind, fields, map, defaults }: FormProps & { defaults?: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  if (!open) return <Button onClick={() => setOpen(true)}>Добавить</Button>;
  return (
    <Card className="w-full p-4">
      <EntityForm
        fields={fields}
        initial={defaults}
        map={map}
        save={(data) => saveRefAction(kind, null, data)}
        onDone={() => setOpen(false)}
        onCancel={() => setOpen(false)}
      />
    </Card>
  );
}

export function EditRefForm({
  kind,
  id,
  fields,
  map,
  initial,
  active,
}: FormProps & { id: string; initial: Record<string, unknown>; active: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggleActive() {
    setError(null);
    startTransition(async () => {
      const result = await setRefActiveAction(kind, id, !active);
      if (!result.ok) setError(result.message);
      else router.refresh();
    });
  }

  return (
    <Card className="space-y-4 p-4">
      <EntityForm
        fields={fields}
        initial={initial}
        map={map}
        save={(data) => saveRefAction(kind, id, data)}
        onDone={() => router.push(`/refs/${kind}`)}
      />
      <div className="border-t border-gray-100 pt-3">
        <ErrorText>{error}</ErrorText>
        <Button variant={active ? "danger" : "secondary"} onClick={toggleActive} disabled={pending}>
          {active ? "Деактивировать" : "Вернуть в работу"}
        </Button>
      </div>
    </Card>
  );
}
