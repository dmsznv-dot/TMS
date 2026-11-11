import { Forbidden } from "@/components/Forbidden";
import { Badge, Card, EmptyState, PageHeader, tableClass, tdClass, thClass } from "@/components/ui";
import { EXPENSE_LABELS } from "@/domain/costEstimate";
import { formatRub } from "@/domain/money";
import { can } from "@/domain/permissions";
import { formatInTz } from "@/domain/time";
import { requireCtx } from "@/server/auth/requireCtx";
import { listExpenses, listInvoices, listPayments } from "@/server/services/finance";
import { listCounterparties } from "@/server/services/refs";
import { listTrips } from "@/server/services/trips";
import { LinkExpenseRow, PaymentCard, PaymentForm } from "./MoneyScreen";

const INVOICE_STATE = { unpaid: "не оплачен", partially_paid: "оплачен частично", paid: "оплачен" } as const;

export default async function MoneyPage() {
  const ctx = await requireCtx();
  if (!can(ctx.actor.role, "money.read")) return <Forbidden />;
  const canWrite = can(ctx.actor.role, "money.write");

  const [invoices, payments, counterparties, unlinked, trips] = await Promise.all([
    listInvoices(ctx),
    listPayments(ctx),
    canWrite ? listCounterparties(ctx, { activeOnly: true }) : [],
    listExpenses(ctx, { unlinked: true }),
    canWrite ? listTrips(ctx) : [],
  ]);
  const tripNumber = new Map((await listTrips(ctx)).map((t) => [t.id, t.number]));

  return (
    <>
      <PageHeader title="Счета и оплаты" />
      <div className="space-y-6">
        {canWrite && <PaymentForm counterparties={counterparties.map((c) => ({ id: c.id, name: c.name }))} />}

        <section aria-label="Платежи" className="space-y-3">
          <h2 className="font-semibold">Платежи</h2>
          {payments.length === 0 ? (
            <Card>
              <EmptyState>Платежей пока нет.</EmptyState>
            </Card>
          ) : (
            payments.map((p) => (
              <PaymentCard
                key={`${p.id}:${p.state}:${p.remainingKop}`}
                payment={p}
                candidates={invoices
                  .filter((i) => i.counterpartyId === p.counterpartyId && i.direction === (p.direction === "in" ? "out" : "in") && i.remainingKop > 0)
                  .map((i) => ({ id: i.id, number: i.number, remainingKop: i.remainingKop }))}
              />
            ))
          )}
        </section>

        <section aria-label="Счета" className="space-y-3">
          <h2 className="font-semibold">Счета</h2>
          <Card className="overflow-x-auto">
            {invoices.length === 0 ? (
              <EmptyState>Счетов пока нет.</EmptyState>
            ) : (
              <table className={tableClass}>
                <thead>
                  <tr>
                    {["Счёт", "Контрагент", "Рейс", "Сумма", "Оплачено", "Остаток", "Срок", "Состояние"].map((h) => (
                      <th key={h} className={thClass}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((i) => (
                    <tr key={i.id}>
                      <td className={tdClass}>
                        {i.direction === "out" ? "Исх." : "Вх."} № {i.number}
                      </td>
                      <td className={tdClass}>{i.counterpartyName}</td>
                      <td className={tdClass}>{i.tripId ? (tripNumber.get(i.tripId) ?? "—") : "—"}</td>
                      <td className={tdClass}>{formatRub(i.amountKop)}</td>
                      <td className={tdClass}>{formatRub(i.paidKop)}</td>
                      <td className={tdClass}>{formatRub(i.remainingKop)}</td>
                      <td className={tdClass}>{formatInTz(i.dueDate, "Europe/Moscow", "dd.MM.yyyy")}</td>
                      <td className={tdClass}>
                        <Badge tone={i.state === "paid" ? "green" : i.overdue ? "red" : "amber"}>{i.overdue ? "просрочен" : INVOICE_STATE[i.state]}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </section>

        {unlinked.length > 0 && (
          <section aria-label="Расходы без связи" className="space-y-3">
            <h2 className="font-semibold">Расходы без связи с рейсом</h2>
            <Card className="p-4">
              <ul className="space-y-2 text-sm">
                {unlinked.map((x) =>
                  canWrite ? (
                    <LinkExpenseRow
                      key={x.id}
                      expenseId={x.id}
                      text={`${EXPENSE_LABELS[x.category]}: ${formatRub(x.amountKop)}${x.source ? `, ${x.source}` : ""} · ${formatInTz(x.date, "Europe/Moscow", "dd.MM.yyyy")}`}
                      trips={trips.map((t) => ({ id: t.id, number: t.number }))}
                    />
                  ) : (
                    <li key={x.id}>{EXPENSE_LABELS[x.category]}: {formatRub(x.amountKop)}</li>
                  ),
                )}
              </ul>
            </Card>
          </section>
        )}
      </div>
    </>
  );
}
