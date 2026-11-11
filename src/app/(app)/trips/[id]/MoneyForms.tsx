"use client";

import { useState } from "react";
import {
  addAccrualAction,
  addExpenseAction,
  closeTripAction,
  createInvoiceAction,
  markNotIncurredAction,
  verifyExpenseAction,
} from "@/app/actions/finance";
import { Button, Card, ErrorText, inputClass } from "@/components/ui";
import { useAction } from "@/components/useAction";
import { EXPENSE_LABELS, type ExpenseCategory } from "@/domain/costEstimate";
import { parseRub } from "@/domain/money";
import { zonedToUtc } from "@/domain/time";

const todayLocal = (tz: string) => new Intl.DateTimeFormat("sv-SE", { timeZone: tz }).format(new Date());
const label = "mb-1 block text-xs text-gray-500";

function amountOf(text: string): number | null {
  const kop = parseRub(text);
  return kop != null && kop > 0 ? kop : null;
}

export function AccrualForm({ tripId }: { tripId: string }) {
  const { error, pending, run, setError } = useAction();
  const [kind, setKind] = useState<"revenue" | "surcharge">("revenue");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [vat, setVat] = useState(false);

  function add() {
    const kop = amountOf(amount);
    if (kop == null) return setError("Сумма — положительное число в рублях");
    run(() => addAccrualAction(tripId, { kind, description, amountKop: kop, vatIncluded: vat }), () => {
      setDescription("");
      setAmount("");
    });
  }
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-4">
        <label className="block">
          <span className={label}>Вид</span>
          <select aria-label="Вид начисления" className={inputClass} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="revenue">Выручка за перевозку</option>
            <option value="surcharge">Доплата (простой и т. п.)</option>
          </select>
        </label>
        <label className="block md:col-span-2">
          <span className={label}>Описание</span>
          <input aria-label="Описание начисления" className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="block">
          <span className={label}>Сумма, ₽</span>
          <input aria-label="Сумма начисления, ₽" className={inputClass} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
      </div>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={vat} onChange={(e) => setVat(e.target.checked)} />
        Сумма с НДС
      </label>
      <ErrorText>{error}</ErrorText>
      <Button variant="secondary" disabled={pending} onClick={add}>
        Добавить начисление
      </Button>
    </div>
  );
}

export function ExpenseForm({ tripId, tz }: { tripId: string; tz: string }) {
  const { error, pending, run, setError } = useAction();
  const [category, setCategory] = useState<ExpenseCategory>("fuel");
  const [amount, setAmount] = useState("");
  const [vat, setVat] = useState(false);
  const [date, setDate] = useState(todayLocal(tz));
  const [source, setSource] = useState("");
  const [estimate, setEstimate] = useState(false);

  function add() {
    const kop = amountOf(amount);
    if (kop == null) return setError("Сумма — положительное число в рублях");
    run(
      () =>
        addExpenseAction(tripId, { category, amountKop: kop, vatIncluded: vat, date: zonedToUtc(`${date}T12:00`, tz), source: source.trim() || undefined, isEstimate: estimate }),
      () => setAmount(""),
    );
  }
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-4">
        <label className="block">
          <span className={label}>Статья</span>
          <select aria-label="Статья расхода" className={inputClass} value={category} onChange={(e) => setCategory(e.target.value as ExpenseCategory)}>
            {(Object.keys(EXPENSE_LABELS) as ExpenseCategory[]).map((c) => (
              <option key={c} value={c}>
                {EXPENSE_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={label}>Сумма, ₽</span>
          <input aria-label="Сумма расхода, ₽" className={inputClass} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="block">
          <span className={label}>Дата</span>
          <input aria-label="Дата расхода" type="date" className={inputClass} value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="block">
          <span className={label}>Источник</span>
          <input aria-label="Источник расхода" className={inputClass} placeholder="чек АЗС, акт, телематика" value={source} onChange={(e) => setSource(e.target.value)} />
        </label>
      </div>
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={vat} onChange={(e) => setVat(e.target.checked)} />
          Сумма с НДС
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={estimate} onChange={(e) => setEstimate(e.target.checked)} />
          Оценка по норме и пробегу
        </label>
      </div>
      <ErrorText>{error}</ErrorText>
      <Button variant="secondary" disabled={pending} onClick={add}>
        Добавить расход
      </Button>
    </div>
  );
}

export function VerifyButton({ tripId, expenseId }: { tripId: string; expenseId: string }) {
  const { error, pending, run } = useAction();
  return (
    <span>
      <Button variant="secondary" disabled={pending} onClick={() => run(() => verifyExpenseAction(tripId, expenseId))}>
        Проверить
      </Button>
      {error && <span className="ml-2 text-xs text-red-700">{error}</span>}
    </span>
  );
}

export function NotIncurredButton({ tripId, category }: { tripId: string; category: ExpenseCategory }) {
  const { error, pending, run } = useAction();
  return (
    <span>
      <Button variant="secondary" disabled={pending} onClick={() => run(() => markNotIncurredAction(tripId, category))}>
        Не было: {EXPENSE_LABELS[category]}
      </Button>
      {error && <span className="ml-2 text-xs text-red-700">{error}</span>}
    </span>
  );
}

type Counterparty = { id: string; name: string };
type OpenAccrual = { id: string; description: string; amountKop: number };

export function InvoiceForm({ tripId, tz, counterparties, accruals }: { tripId: string; tz: string; counterparties: Counterparty[]; accruals: OpenAccrual[] }) {
  const { error, pending, run, setError } = useAction();
  const [direction, setDirection] = useState<"out" | "in">("out");
  const [counterpartyId, setCounterpartyId] = useState("");
  const [number, setNumber] = useState("");
  const [due, setDue] = useState("");
  const [amount, setAmount] = useState("");
  const [vat, setVat] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);

  function create() {
    const kop = amountOf(amount);
    if (kop == null) return setError("Сумма — положительное число в рублях");
    if (!counterpartyId) return setError("Выберите контрагента");
    if (!due) return setError("Укажите срок оплаты");
    run(
      () =>
        createInvoiceAction(tripId, {
          direction,
          counterpartyId,
          number,
          date: new Date(),
          dueDate: zonedToUtc(`${due}T12:00`, tz),
          amountKop: kop,
          vatIncluded: vat,
          accrualIds: picked,
        }),
      () => {
        setNumber("");
        setAmount("");
        setPicked([]);
      },
    );
  }
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-5">
        <label className="block">
          <span className={label}>Направление</span>
          <select aria-label="Направление счёта" className={inputClass} value={direction} onChange={(e) => setDirection(e.target.value as typeof direction)}>
            <option value="out">Выставлен клиенту</option>
            <option value="in">Получен от перевозчика</option>
          </select>
        </label>
        <label className="block">
          <span className={label}>Контрагент</span>
          <select aria-label="Контрагент счёта" className={inputClass} value={counterpartyId} onChange={(e) => setCounterpartyId(e.target.value)}>
            <option value="">— выберите —</option>
            {counterparties.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={label}>Номер</span>
          <input aria-label="Номер счёта" className={inputClass} value={number} onChange={(e) => setNumber(e.target.value)} />
        </label>
        <label className="block">
          <span className={label}>Срок оплаты</span>
          <input aria-label="Срок оплаты" type="date" className={inputClass} value={due} onChange={(e) => setDue(e.target.value)} />
        </label>
        <label className="block">
          <span className={label}>Сумма, ₽</span>
          <input aria-label="Сумма счёта, ₽" className={inputClass} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
      </div>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={vat} onChange={(e) => setVat(e.target.checked)} />
        Сумма счёта с НДС
      </label>
      {accruals.length > 0 && (
        <fieldset className="space-y-1 text-sm">
          <legend className="mb-1 text-xs text-gray-500">Начисления, которые закрывает счёт</legend>
          {accruals.map((a) => (
            <label key={a.id} className="flex items-center gap-2">
              <input type="checkbox" checked={picked.includes(a.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, a.id] : p.filter((x) => x !== a.id)))} />
              {a.description}
            </label>
          ))}
        </fieldset>
      )}
      <ErrorText>{error}</ErrorText>
      <Button variant="secondary" disabled={pending} onClick={create}>
        Создать счёт
      </Button>
    </div>
  );
}

export function CloseForm({ tripId, version, incomplete }: { tripId: string; version: number; incomplete: boolean }) {
  const { error, pending, run } = useAction();
  const [reason, setReason] = useState("");
  return (
    <Card className="space-y-3 p-4">
      {incomplete && (
        <label className="block">
          <span className={label}>Чтобы закрыть рейс при неполных данных, укажите причину</span>
          <input aria-label="Причина закрытия" className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
      )}
      <ErrorText>{error}</ErrorText>
      <Button disabled={pending} onClick={() => run(() => closeTripAction(tripId, version, reason))}>
        Закрыть рейс
      </Button>
    </Card>
  );
}
