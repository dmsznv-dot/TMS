import { Card, PageHeader, buttonClass } from "@/components/ui";
import { can } from "@/domain/permissions";
import { requireCtx } from "@/server/auth/requireCtx";
import { DATASETS, DATASET_LABELS, type Dataset } from "@/server/export";

const DESCRIPTIONS: Record<Dataset, string> = {
  orders: "Строки заказов: остатки, что в рейсах, что принято. Внутренний и внешний номера, источник и время создания.",
  trips: "Рейсы: статус, исполнитель, план, источник расчёта и фактический пробег.",
  acceptance: "Все версии приёмки по грузу с причиной, подтверждением и автором.",
  plan_fact: "План и факт по статьям для каждого рейса, итоговая маржа и результат после расходов парка.",
  invoices_payments: "Счета с остатком долга и платежи с состоянием разнесения.",
};
const MONEY_ONLY: Dataset[] = ["plan_fact", "invoices_payments"];

export default async function ExportPage() {
  const ctx = await requireCtx();
  const canMoney = can(ctx.actor.role, "money.read");
  const datasets = DATASETS.filter((d) => canMoney || !MONEY_ONLY.includes(d));

  return (
    <>
      <PageHeader title="Выгрузки" />
      <p className="mb-4 max-w-2xl text-gray-600">
        Файлы XLSX открываются в Excel. CSV — в кодировке UTF-8 с разделителем «;»: в Excel он откроется с правильной кириллицей. Время указано в UTC.
        Расстояние и время в пути из 2ГИС попадают в файл, только если это разрешено настройкой установки.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        {datasets.map((d) => (
          <Card key={d} className="space-y-3 p-4">
            <div>
              <h2 className="font-semibold">{DATASET_LABELS[d]}</h2>
              <p className="text-sm text-gray-600">{DESCRIPTIONS[d]}</p>
            </div>
            <div className="flex gap-2">
              <a className={buttonClass("secondary")} href={`/api/export?dataset=${d}&format=xlsx`} download>
                XLSX
              </a>
              <a className={buttonClass("secondary")} href={`/api/export?dataset=${d}&format=csv`} download>
                CSV
              </a>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
