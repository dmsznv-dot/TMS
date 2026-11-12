"use client";

import { useState } from "react";
import { allocatePaymentAction, linkExpenseAction, recordPaymentAction } from "@/app/actions/finance";
import { Badge, Button, Card, ErrorText, inputClass } from "@/components/ui";
import { useAction } from "@/components/useAction";
import { formatRub, parseRub } from "@/domain/money";
import { formatInTz, zonedToUtc } from "@/domain/time";

const TZ = "Europe/Moscow";
const todayLocal = () => new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(new Date());
const label = "mb-1 block text-xs text-gray-500";

type Counterparty = { id: string; name: string };

export function PaymentForm({ counterparties }: { counterparties: Counterparty[] }) {
  const { error, pending, run, setError } = useAction();
  const [direction, setDirection] = useState<"in" | "out">("in");
  const [counterpartyId, setCounterpartyId] = useState("");
  const [date, setDate] = useState(todayLocal());
  const [amount, setAmount] = useState("");
  const [purpose, setPurpose] = useState("");

  function add() {
    const kop = parseRub(amount);
    if (kop == null || kop <= 0) return setError("Сумма — положительное число в рублях");
    if (!counterpartyId) return setError("Выберите контрагента");
    run(
      () => recordPaymentAction({ direction, counterpartyId, date: zonedToUtc(`${date}T12:00`, TZ), amountKop: kop, purpose }),
      () => {
        setAmount("");
        setPurpose("");
      },
    );
  }
  return (
    <Card className="space-y-3 p-4">
      <h2 className="font-semibold">Новый платёж</h2>
      <div className="grid gap-3 md:grid-cols-5">
        <label className="block">
          <span className={label}>Направление</span>
          <select aria-label="Направление платежа" className={inputClass} value={direction} onChange={(e) => setDirection(e.target.value as "in" | "out")}>
            <option value="in">Поступление</option>
            <option value="out">Списание</option>
          </select>
        </label>
        <label className="block">
          <span className={label}>Контрагент</span>
          <select aria-label="Контрагент платежа" className={inputClass} value={counterpartyId} onChange={(e) => setCounterpartyId(e.target.value)}>
            <option value="">— выберите —</option>
            {counterparties.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={label}>Дата</span>
          <input aria-label="Дата платежа" type="date" className={inputClass} value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="block">
          <span className={label}>Сумма, ₽</span>
          <input aria-label="Сумма платежа, ₽" className={inputClass} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="block">
          <span className={label}>Назначение</span>
          <input aria-label="Назначение платежа" className={inputClass} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
        </label>
      </div>
      <p className="text-xs text-gray-500">Платёж сам счёт не закрывает: его разносит человек. Если по назначению или сумме подходит один счёт, платёж ждёт разнесения; иначе нужна проверка.</p>
      <ErrorText>{error}</ErrorText>
      <Button disabled={pending} onClick={add}>
        Внести платёж
      </Button>
    </Card>
  );
}

export type Candidate = { id: string; number: string; remainingKop: number };

export function AllocateForm({ paymentId, remainingKop, candidates }: { paymentId: string; remainingKop: number; candidates: Candidate[] }) {
  const { error, pending, run, setError } = useAction();
  const [invoiceId, setInvoiceId] = useState("");
  const [amount, setAmount] = useState("");

  function pick(id: string) {
    setInvoiceId(id);
    const invoice = candidates.find((c) => c.id === id);
    if (invoice) setAmount((Math.min(remainingKop, invoice.remainingKop) / 100).toFixed(2).replace(".", ","));
  }

  function allocate() {
    const kop = parseRub(amount);
    if (!invoiceId) return setError("Выберите счёт");
    if (kop == null || kop <= 0) return setError("Сумма — положительное число в рублях");
    run(() => allocatePaymentAction(paymentId, invoiceId, kop));
  }
  if (candidates.length === 0) return <p className="text-xs text-gray-500">Нет открытых счетов этого контрагента, на которые можно разнести платёж.</p>;
  return (
    <div className="space-y-2">
      <div className="grid gap-3 md:grid-cols-3">
        <label className="block">
          <span className={label}>Счёт</span>
          <select aria-label="Счёт для разнесения" className={inputClass} value={invoiceId} onChange={(e) => pick(e.target.value)}>
            <option value="">— выберите —</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                № {c.number}, остаток {formatRub(c.remainingKop)}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={label}>Сумма, ₽</span>
          <input aria-label="Сумма разнесения, ₽" className={inputClass} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
      </div>
      <ErrorText>{error}</ErrorText>
      <Button variant="secondary" disabled={pending} onClick={allocate}>
        Разнести
      </Button>
    </div>
  );
}

const STATE_LABELS = {
  unallocated: { text: "Ждёт разнесения", tone: "blue" },
  needs_review: { text: "Требует проверки", tone: "amber" },
  partially_allocated: { text: "Разнесён частично", tone: "amber" },
  allocated: { text: "Разнесён полностью", tone: "green" },
} as const;

type PaymentCardProps = {
  payment: {
    id: string;
    direction: "in" | "out";
    counterpartyName: string;
    date: Date;
    amountKop: number;
    purpose: string;
    state: keyof typeof STATE_LABELS;
    remainingKop: number;
  };
  candidates: Candidate[];
};

export function PaymentCard({ payment, candidates }: PaymentCardProps) {
  const state = STATE_LABELS[payment.state];
  return (
    <Card className="space-y-2 p-4">
      <div data-testid="payment-card" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium">
            {payment.direction === "in" ? "Поступление" : "Списание"} {formatRub(payment.amountKop)} · {payment.counterpartyName}
          </h3>
          <Badge tone={state.tone}>{state.text}</Badge>
        </div>
        <p className="text-sm text-gray-600">
          {formatInTz(payment.date, TZ, "dd.MM.yyyy")}
          {payment.purpose ? ` · ${payment.purpose}` : ""} · не разнесено {formatRub(payment.remainingKop)}
        </p>
        {payment.remainingKop > 0 && <AllocateForm paymentId={payment.id} remainingKop={payment.remainingKop} candidates={candidates} />}
      </div>
    </Card>
  );
}

export function LinkExpenseRow({ expenseId, text, trips }: { expenseId: string; text: string; trips: { id: string; number: string }[] }) {
  const { error, pending, run, setError } = useAction();
  const [tripId, setTripId] = useState("");
  return (
    <li className="flex flex-wrap items-center gap-2">
      <span className="min-w-56 flex-1">{text}</span>
      <select aria-label="Рейс для привязки" className={`${inputClass} w-auto`} value={tripId} onChange={(e) => setTripId(e.target.value)}>
        <option value="">— рейс —</option>
        {trips.map((t) => (
          <option key={t.id} value={t.id}>
            {t.number}
          </option>
        ))}
      </select>
      <Button variant="secondary" disabled={pending} onClick={() => (tripId ? run(() => linkExpenseAction(expenseId, tripId)) : setError("Выберите рейс"))}>
        Привязать
      </Button>
      {error && <span className="text-xs text-red-700">{error}</span>}
    </li>
  );
}
