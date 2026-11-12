"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { uploadImportAction } from "@/app/actions/import";
import { buttonClass, ErrorText, inputClass } from "@/components/ui";

export function UploadForm({ templates }: { templates: { id: string; name: string }[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await uploadImportAction(formData);
      if (!result.ok) setError(result.message);
      else router.push(`/import/${result.data.jobId}`);
    });
  }

  if (templates.length === 0) {
    return <p className="text-gray-600">Шаблонов импорта пока нет. Шаблон создаёт администратор.</p>;
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block">
          <span className="mb-1 block font-medium">Файл с заказами</span>
          <input name="file" type="file" accept=".xlsx,.csv,.txt" required className={inputClass} />
        </label>
        <label className="block">
          <span className="mb-1 block font-medium">Шаблон</span>
          <select name="templateId" required className={inputClass} defaultValue={templates[0].id}>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorText>{error}</ErrorText>
      <button type="submit" disabled={pending} className={buttonClass()}>
        Загрузить и проверить
      </button>
      <p className="text-xs text-gray-500">Форматы: XLSX и CSV. На этом шаге заказы ещё не записываются.</p>
    </form>
  );
}
