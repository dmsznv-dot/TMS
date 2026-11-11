import { Badge, Card, EmptyState, tableClass, tdClass, thClass } from "@/components/ui";
import { COMPLETENESS_LABELS } from "@/domain/completeness";
import { EXPENSE_LABELS } from "@/domain/costEstimate";
import { formatRub } from "@/domain/money";
import { can } from "@/domain/permissions";
import { formatInTz } from "@/domain/time";
import type { UserCtx } from "@/server/auth/requireCtx";
import { getCompleteness } from "@/server/services/close";
import { getTripEconomics } from "@/server/services/economics";
import { listCounterparties } from "@/server/services/refs";
import type { TripView } from "@/server/services/trips";
import { AccrualForm, CloseForm, ExpenseForm, InvoiceForm, NotIncurredButton, VerifyButton } from "./MoneyForms";

const money = (kop: number | null) => (kop == null ? <Badge tone="amber">неизвестно</Badge> : formatRub(kop));
const signed = (kop: number) => `${kop > 0 ? "+" : ""}${formatRub(kop)}`;

export async function MoneyTab({ ctx, trip }: { ctx: UserCtx; trip: TripView }) {
  const role = ctx.actor.role;
  const canWrite = can(role, "money.write") && trip.status !== "closed" && trip.status !== "cancelled";
  const tz = trip.stops[0].location.tz;
  const [e, completeness, counterparties] = await Promise.all([
    getTripEconomics(ctx, trip.id),
    getCompleteness(ctx, trip.id),
    canWrite ? listCounterparties(ctx, { activeOnly: true }) : [],
  ]);
  const { plan, fact } = e.result;
  const planLabel = e.basis === "baseline" ? "План на момент назначения" : e.basis === "current" ? "Текущий план (рейс ещё не назначен)" : "Плана нет";

  return (
    <div className="space-y-6">
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-semibold">Результат рейса: план и факт</h2>
          <span className="text-xs text-gray-500">{planLabel}. Суммы без НДС.</span>
        </div>
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={thClass}>Статья</th>
                <th className={`${thClass} text-right`}>План</th>
                <th className={`${thClass} text-right`}>Факт</th>
                <th className={`${thClass} text-right`}>Отклонение</th>
              </tr>
            </thead>
            <tbody>
              {e.categories.map((c) => {
                const d = e.deviation.find((x) => x.category === c.category);
                return (
                  <tr key={c.category}>
                    <td className={tdClass}>{EXPENSE_LABELS[c.category]}</td>
                    <td className={`${tdClass} text-right`}>{money(c.planKop)}</td>
                    <td className={`${tdClass} text-right`}>{c.factKop === null ? <Badge tone="amber">нет факта</Badge> : money(c.factKop)}</td>
                    <td className={`${tdClass} text-right`}>{d ? signed(d.kop) : "—"}</td>
                  </tr>
                );
              })}
              <tr className="font-medium">
                <td className={tdClass}>Прямые расходы{fact.incomplete ? " (неполные)" : ""}</td>
                <td className={`${tdClass} text-right`}>{formatRub(plan.directKop)}</td>
                <td className={`${tdClass} text-right`}>{formatRub(fact.directKop)}</td>
                <td className={`${tdClass} text-right`}>{signed(e.result.deviationTotalKop)}</td>
              </tr>
              <tr>
                <td className={tdClass}>Выручка и доплаты</td>
                <td className={`${tdClass} text-right`}>{e.revenueKop == null ? "—" : formatRub(e.revenueKop)}</td>
                <td className={`${tdClass} text-right`}>{e.revenueKop == null ? "—" : formatRub(e.revenueKop + e.surchargesKop)}</td>
                <td className={`${tdClass} text-right`}>{e.surchargesKop ? signed(e.surchargesKop) : "—"}</td>
              </tr>
              <tr className="font-medium">
                <td className={tdClass}>Маржинальный доход</td>
                <td data-testid="plan-margin" className={`${tdClass} text-right`}>{plan.marginKop == null ? "—" : formatRub(plan.marginKop)}</td>
                <td data-testid="fact-margin" className={`${tdClass} text-right`}>{fact.marginKop == null ? "—" : formatRub(fact.marginKop)}</td>
                <td className={`${tdClass} text-right`}>
                  {plan.marginKop != null && fact.marginKop != null ? signed(fact.marginKop - plan.marginKop) : "—"}
                </td>
              </tr>
              <tr>
                <td className={tdClass}>Расходы парка ({e.fleet.rule === "days" ? "по дням" : "по пробегу"})</td>
                <td className={`${tdClass} text-right`}>{money(e.fleet.plan)}</td>
                <td className={`${tdClass} text-right`}>{money(e.fleet.fact)}</td>
                <td className={`${tdClass} text-right`}>—</td>
              </tr>
              <tr className="font-medium">
                <td className={tdClass}>Результат после расходов парка</td>
                <td className={`${tdClass} text-right`}>{plan.afterFleetKop == null ? "—" : formatRub(plan.afterFleetKop)}</td>
                <td className={`${tdClass} text-right`}>{fact.afterFleetKop == null ? "—" : formatRub(fact.afterFleetKop)}</td>
                <td className={`${tdClass} text-right`}>
                  {plan.afterFleetKop != null && fact.afterFleetKop != null ? signed(fact.afterFleetKop - plan.afterFleetKop) : "—"}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {e.deviation.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Из чего сложилось отклонение</h3>
            {e.deviation.map((d) => (
              <details key={d.category} className="rounded-md border border-gray-200 px-3 py-2 text-sm">
                <summary className="cursor-pointer">
                  {EXPENSE_LABELS[d.category]}: {signed(d.kop)}
                </summary>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-700">
                  {e.expenses
                    .filter((x) => d.expenseIds.includes(x.id))
                    .map((x) => (
                      <li key={x.id}>
                        {formatInTz(x.date, tz, "dd.MM.yyyy")}: {formatRub(x.netKop)} без НДС{x.source ? `, ${x.source}` : ""}
                        {x.isEstimate ? " (оценка)" : ""}
                      </li>
                    ))}
                </ul>
              </details>
            ))}
          </div>
        )}
        {e.unknownCategories.length > 0 && (
          <p className="text-xs text-amber-800">Неизвестно, пока нет факта или плановой суммы: {e.unknownCategories.map((c) => EXPENSE_LABELS[c]).join(", ")}.</p>
        )}
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="font-semibold">Стоимость доставки по заказам</h2>
        <p className="text-xs text-gray-500">
          Распределяется {e.delivery.allocationBase === "pallets" ? "по паллетам" : "по весу"}. До распределения: {formatRub(e.delivery.totalKop)} (
          {e.delivery.costSource === "fact" ? "по факту" : "по плану"}).
        </p>
        {e.delivery.missing.length > 0 && (
          <p className="text-sm text-amber-800">У заказов {e.delivery.missing.join(", ")} нет {e.delivery.allocationBase === "pallets" ? "паллет" : "веса"}: распределить нечего.</p>
        )}
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Заказ</th>
              <th className={`${thClass} text-right`}>Доля доставки</th>
              <th className={`${thClass} text-right`}>Маржа заказа</th>
            </tr>
          </thead>
          <tbody>
            {e.delivery.orders.map((o) => (
              <tr key={o.orderId}>
                <td className={tdClass}>{o.orderNumber}</td>
                <td className={`${tdClass} text-right`}>{o.shareKop == null ? "—" : formatRub(o.shareKop)}</td>
                <td className={`${tdClass} text-right`}>{o.marginKop == null ? "нет цены или себестоимости" : formatRub(o.marginKop)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="font-semibold">Начисления</h2>
        {e.accruals.length === 0 ? (
          <p className="text-gray-500">Начислений нет.</p>
        ) : (
          <ul data-testid="accrual-list" className="space-y-1 text-sm">
            {e.accruals.map((a) => (
              <li key={a.id}>
                {a.kind === "revenue" ? "Выручка" : "Доплата"}: {a.description} — {formatRub(a.amountKop)}
                {a.vatIncluded ? " с НДС" : " без НДС"} <Badge tone={a.state === "invoiced" ? "green" : "amber"}>{a.state === "invoiced" ? "в счёте" : "без счёта"}</Badge>
              </li>
            ))}
          </ul>
        )}
        {canWrite && <AccrualForm tripId={trip.id} />}
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="font-semibold">Фактические расходы</h2>
        {e.expenses.length === 0 ? (
          <p className="text-gray-500">Расходов пока нет.</p>
        ) : (
          <ul data-testid="expense-list" className="space-y-2 text-sm">
            {e.expenses.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {EXPENSE_LABELS[x.category]}: {x.notIncurred ? "не было" : `${formatRub(x.amountKop)}${x.vatIncluded ? " с НДС" : " без НДС"}`}
                  {!x.notIncurred && x.vatIncluded && <span className="text-gray-500"> (без НДС {formatRub(x.netKop)})</span>}
                  <span className="text-gray-500">
                    {" "}· {formatInTz(x.date, tz, "dd.MM.yyyy")}
                    {x.source ? ` · ${x.source}` : ""}
                  </span>{" "}
                  {x.isEstimate && <Badge>оценка</Badge>} <Badge tone={x.checkStatus === "verified" ? "green" : "amber"}>{x.checkStatus === "verified" ? "проверен" : "не проверен"}</Badge>
                </span>
                {canWrite && x.checkStatus === "unverified" && <VerifyButton tripId={trip.id} expenseId={x.id} />}
              </li>
            ))}
          </ul>
        )}
        {canWrite && e.missingFact.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {e.missingFact.map((c) => (
              <NotIncurredButton key={c} tripId={trip.id} category={c} />
            ))}
          </div>
        )}
        {canWrite && <ExpenseForm tripId={trip.id} tz={tz} />}
      </Card>

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-semibold">Счета и долг</h2>
          <span className="text-xs text-gray-500">Долг показывается отдельно: оплата не меняет результат рейса.</span>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-md border border-gray-200 p-3">
            <div className="text-xs text-gray-500">Нам должны</div>
            <div data-testid="debt-receivable" className="text-xl font-semibold">{formatRub(e.debt.receivableKop)}</div>
          </div>
          <div className="rounded-md border border-gray-200 p-3">
            <div className="text-xs text-gray-500">Мы должны</div>
            <div data-testid="debt-payable" className="text-xl font-semibold">{formatRub(e.debt.payableKop)}</div>
          </div>
        </div>
        {e.invoices.length === 0 ? (
          <p className="text-gray-500">Счетов нет.</p>
        ) : (
          <ul data-testid="invoice-list" className="space-y-1 text-sm">
            {e.invoices.map((i) => (
              <li key={i.id}>
                {i.direction === "out" ? "Клиенту" : "От перевозчика"} {i.counterpartyName}, счёт № {i.number} на {formatRub(i.amountKop)}: оплачено {formatRub(i.paidKop)}, остаток {formatRub(i.remainingKop)}{" "}
                <Badge tone={i.state === "paid" ? "green" : i.overdue ? "red" : "amber"}>{i.state === "paid" ? "оплачен" : i.overdue ? "просрочен" : i.state === "partially_paid" ? "оплачен частично" : "не оплачен"}</Badge>
              </li>
            ))}
          </ul>
        )}
        {canWrite && <InvoiceForm tripId={trip.id} tz={tz} counterparties={counterparties.map((c) => ({ id: c.id, name: c.name }))} accruals={e.accruals.filter((a) => a.state === "agreed").map((a) => ({ id: a.id, description: `${a.description} — ${formatRub(a.amountKop)}`, amountKop: a.amountKop }))} />}
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="font-semibold">Закрытие рейса</h2>
        <div data-testid="completeness">
          {completeness.ok ? (
            <p className="text-green-800">Данные рейса полны.</p>
          ) : (
            <ul className="list-disc space-y-1 pl-5 text-sm text-amber-900">
              {completeness.failed.map((c) => (
                <li key={c}>{COMPLETENESS_LABELS[c]}</li>
              ))}
            </ul>
          )}
        </div>
        {trip.status === "completed" && can(role, "trip.close") ? (
          <CloseForm tripId={trip.id} version={trip.version} incomplete={!completeness.ok} />
        ) : trip.status === "closed" ? (
          <p className="text-green-800">Рейс закрыт{trip.closeOverrideReason ? ` с исключением: ${trip.closeOverrideReason}` : ""}.</p>
        ) : (
          <EmptyState>Закрыть можно выполненный рейс, ролям финансов и администратора.</EmptyState>
        )}
      </Card>
    </div>
  );
}
