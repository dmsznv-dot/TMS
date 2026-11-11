"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { readHeadersAction, saveTemplateAction, type SheetHeaders } from "@/app/actions/import";
import { Button, buttonClass, Card, ErrorText, inputClass } from "@/components/ui";
import {
  DATE_FORMATS,
  ORDER_FIELD_LABELS,
  ORDER_FIELDS,
  REQUIRED_ORDER_FIELDS,
  type DateFormat,
  type OrderField,
} from "@/domain/importMapping";

export function TemplateEditor() {
  const router = useRouter();
  const [sheets, setSheets] = useState<SheetHeaders[] | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [columns, setColumns] = useState<Partial<Record<OrderField, string>>>({});
  const [name, setName] = useState("");
  const [dateFormat, setDateFormat] = useState<DateFormat>("dd.MM.yyyy HH:mm");
  const [timezone, setTimezone] = useState("location");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function readHeaders(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await readHeadersAction(formData);
      if (!result.ok) return setError(result.message);
      if (result.data.length === 0) return setError("В файле нет строки с названиями колонок");
      setSheets(result.data);
      setSheetIndex(0);
      setColumns(result.data[0].suggested);
    });
  }

  function chooseSheet(index: number) {
    setSheetIndex(index);
    setColumns(sheets![index].suggested);
  }

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await saveTemplateAction(name, { columns, dateFormat, timezone });
      if (!result.ok) return setError(result.message);
      router.push("/import");
      router.refresh();
    });
  }

  const sheet = sheets?.[sheetIndex];

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <form onSubmit={readHeaders} className="flex flex-wrap items-end gap-3">
          <label className="block min-w-64 flex-1">
            <span className="mb-1 block font-medium">Файл-образец</span>
            <input name="file" type="file" accept=".xlsx,.csv,.txt" required className={inputClass} />
          </label>
          <button type="submit" disabled={pending} className={buttonClass("secondary")}>
            Прочитать колонки
          </button>
        </form>
        <p className="mt-2 text-xs text-gray-500">Из файла берутся только названия колонок. Сам файл не сохраняется.</p>
      </Card>

      {sheet && (
        <Card className="space-y-4 p-4">
          {sheets!.length > 1 && (
            <label className="block max-w-xs">
              <span className="mb-1 block font-medium">Лист</span>
              <select className={inputClass} value={sheetIndex} onChange={(e) => chooseSheet(Number(e.target.value))}>
                {sheets!.map((s, i) => (
                  <option key={s.name} value={i}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div>
            <h2 className="mb-2 font-semibold">Колонки файла</h2>
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {ORDER_FIELDS.map((field) => {
                const required = REQUIRED_ORDER_FIELDS.includes(field);
                return (
                  <div key={field}>
                    <label htmlFor={`map-${field}`} className="mb-1 block font-medium">
                      {ORDER_FIELD_LABELS[field]}
                    </label>
                    <select
                      id={`map-${field}`}
                      className={inputClass}
                      value={columns[field] ?? ""}
                      onChange={(e) =>
                        setColumns((c) => {
                          const next = { ...c };
                          if (e.target.value) next[field] = e.target.value;
                          else delete next[field];
                          return next;
                        })
                      }
                    >
                      <option value="">{required ? "— выберите колонку —" : "— нет в файле —"}</option>
                      {sheet.headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                    {required && <p className="mt-1 text-xs text-gray-500">Обязательное поле</p>}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <label className="block">
              <span className="mb-1 block font-medium">Формат даты и времени</span>
              <select className={inputClass} value={dateFormat} onChange={(e) => setDateFormat(e.target.value as DateFormat)}>
                {DATE_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {f === "dd.MM.yyyy HH:mm" ? "31.12.2026 14:00" : "2026-12-31 14:00"}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block font-medium">Часовой пояс времени в файле</span>
              <select className={inputClass} value={timezone === "location" ? "location" : "fixed"} onChange={(e) => setTimezone(e.target.value === "location" ? "location" : "Europe/Moscow")}>
                <option value="location">Местное время точки доставки</option>
                <option value="fixed">Один пояс для всего файла</option>
              </select>
            </label>
            {timezone !== "location" && (
              <label className="block">
                <span className="mb-1 block font-medium">Пояс</span>
                <input className={inputClass} value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Europe/Moscow" />
              </label>
            )}
          </div>

          <label className="block max-w-sm">
            <span className="mb-1 block font-medium">Название шаблона</span>
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
          </label>

          <ErrorText>{error}</ErrorText>
          <Button onClick={save} disabled={pending}>
            Сохранить шаблон
          </Button>
        </Card>
      )}
      {!sheet && <ErrorText>{error}</ErrorText>}
    </div>
  );
}
