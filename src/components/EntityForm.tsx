"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ActionResult } from "@/app/actions/run";
import { MapPicker } from "./MapPicker";
import { Button, buttonClass, ErrorText, inputClass } from "./ui";

export type FieldSpec = {
  name: string;
  label: string;
  type: "text" | "number" | "select" | "checkbox" | "textarea" | "time" | "intlist";
  options?: { value: string; label: string }[];
  required?: boolean;
  step?: string;
  placeholder?: string;
  hint?: string;
};

type Values = Record<string, string | boolean>;

function toFormValue(field: FieldSpec, raw: unknown): string | boolean {
  if (field.type === "checkbox") return Boolean(raw);
  if (raw == null) return "";
  if (Array.isArray(raw)) return raw.join(", ");
  return String(raw);
}

/** Converts form text into the value the service expects; empty text becomes null. */
function toPayload(field: FieldSpec, value: string | boolean): unknown {
  if (field.type === "checkbox") return Boolean(value);
  const text = String(value).trim();
  if (field.type === "intlist") {
    return text === "" ? [] : text.split(/[\s,;]+/).filter(Boolean).map(Number);
  }
  if (text === "") return field.required ? undefined : null;
  if (field.type === "number") return Number(text.replace(",", "."));
  return text;
}

type Props = {
  fields: FieldSpec[];
  initial?: Record<string, unknown>;
  /** Server action that saves the collected values. */
  save(data: Record<string, unknown>): Promise<ActionResult<unknown>>;
  /** Names of the latitude and longitude fields a map click fills in. */
  map?: { latField: string; lonField: string; tileUrl: string };
  onDone?(): void;
  onCancel?(): void;
};

export function EntityForm({ fields, initial = {}, save, map, onDone, onCancel }: Props) {
  const router = useRouter();
  const [values, setValues] = useState<Values>(() =>
    Object.fromEntries(fields.map((f) => [f.name, toFormValue(f, initial[f.name])])),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const set = (name: string, value: string | boolean) => setValues((v) => ({ ...v, [name]: value }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const data = Object.fromEntries(fields.map((f) => [f.name, toPayload(f, values[f.name])]));
    startTransition(async () => {
      const result = await save(data);
      if (!result.ok) {
        const labelled = Object.entries(result.fields ?? {}).map(([name, message]) => {
          const label = fields.find((f) => f.name === name)?.label ?? name;
          return `${label}: ${message}`;
        });
        setError(labelled.length > 0 ? labelled.join("; ") : result.message);
        return;
      }
      router.refresh();
      onDone?.();
    });
  }

  const asNumber = (name: string) => {
    const text = String(values[name] ?? "").replace(",", ".");
    return text.trim() === "" ? null : Number(text);
  };

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {fields.map((f) => {
          const id = `field-${f.name}`;
          if (f.type === "checkbox") {
            return (
              <label key={f.name} htmlFor={id} className="flex items-center gap-2 pt-6">
                <input
                  id={id}
                  type="checkbox"
                  checked={Boolean(values[f.name])}
                  onChange={(e) => set(f.name, e.target.checked)}
                />
                <span>{f.label}</span>
              </label>
            );
          }
          return (
            <div key={f.name} className={f.type === "textarea" ? "md:col-span-2 lg:col-span-3" : ""}>
              <label htmlFor={id} className="mb-1 block font-medium">
                {f.label}
              </label>
              {f.type === "select" ? (
                <select id={id} className={inputClass} value={String(values[f.name])} onChange={(e) => set(f.name, e.target.value)}>
                  {!f.required && <option value="">—</option>}
                  {f.options?.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : f.type === "textarea" ? (
                <textarea id={id} rows={2} className={inputClass} value={String(values[f.name])} onChange={(e) => set(f.name, e.target.value)} />
              ) : (
                <input
                  id={id}
                  type={f.type === "time" ? "time" : "text"}
                  inputMode={f.type === "number" ? "decimal" : undefined}
                  placeholder={f.placeholder}
                  className={inputClass}
                  value={String(values[f.name])}
                  onChange={(e) => set(f.name, e.target.value)}
                />
              )}
              {f.hint && <p className="mt-1 text-xs text-gray-500">{f.hint}</p>}
            </div>
          );
        })}
      </div>

      {map && (
        <div>
          <p className="mb-1 text-xs text-gray-500">Клик по карте заполняет широту и долготу.</p>
          <MapPicker
            lat={asNumber(map.latField)}
            lon={asNumber(map.lonField)}
            tileUrl={map.tileUrl}
            onChange={(lat, lon) => {
              set(map.latField, String(lat));
              set(map.lonField, String(lon));
            }}
          />
        </div>
      )}

      <ErrorText>{error}</ErrorText>

      <div className="flex gap-2">
        <button type="submit" disabled={pending} className={buttonClass()}>
          Сохранить
        </button>
        {onCancel && (
          <Button variant="secondary" onClick={onCancel} disabled={pending}>
            Отмена
          </Button>
        )}
      </div>
    </form>
  );
}
