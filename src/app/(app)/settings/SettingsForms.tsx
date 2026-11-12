"use client";

import { useState } from "react";
import { createUserAction, setUserActiveAction, updateSettingsAction } from "@/app/actions/settings";
import { Button, Card, ErrorText, inputClass } from "@/components/ui";
import { useAction } from "@/components/useAction";
import { formatRub, parseRub } from "@/domain/money";
import { ROLE_LABELS, ROLES, type Role } from "@/domain/permissions";

const label = "mb-1 block font-medium";
const hint = "mt-1 block text-xs text-gray-500";

const rubles = (kop: number) => (kop / 100).toFixed(2).replace(".", ",");

export type SettingsValues = {
  name: string;
  vatRateBp: number;
  deliveryAllocBase: "pallets" | "weight";
  fleetRule: "days" | "km";
  fleetRateKop: number;
  fuelPriceKopPerL: number;
  driverHourKop: number;
  windowBufferMin: number;
};

export function SettingsForm({ initial }: { initial: SettingsValues }) {
  const { error, pending, run, setError } = useAction();
  const [saved, setSaved] = useState(false);
  const [name, setName] = useState(initial.name);
  const [vat, setVat] = useState(String(initial.vatRateBp / 100).replace(".", ","));
  const [base, setBase] = useState(initial.deliveryAllocBase);
  const [fleetRule, setFleetRule] = useState(initial.fleetRule);
  const [fleetRate, setFleetRate] = useState(rubles(initial.fleetRateKop));
  const [fuel, setFuel] = useState(rubles(initial.fuelPriceKopPerL));
  const [driver, setDriver] = useState(rubles(initial.driverHourKop));
  const [buffer, setBuffer] = useState(String(initial.windowBufferMin));

  function save() {
    setSaved(false);
    const vatPercent = Number(vat.replace(",", "."));
    const fleet = parseRub(fleetRate);
    const fuelKop = parseRub(fuel);
    const driverKop = parseRub(driver);
    const bufferMin = Number(buffer);
    if (!Number.isFinite(vatPercent) || vatPercent < 0 || vatPercent > 100) return setError("Ставка НДС — число от 0 до 100");
    if (fleet == null || fuelKop == null || driverKop == null) return setError("Суммы вводятся в рублях, например 70,00");
    if (!Number.isInteger(bufferMin) || bufferMin < 0) return setError("Запас по окну — целое число минут");
    run(
      () =>
        updateSettingsAction({
          name,
          vatRateBp: Math.round(vatPercent * 100),
          deliveryAllocBase: base,
          fleetRule,
          fleetRateKop: fleet,
          fuelPriceKopPerL: fuelKop,
          driverHourKop: driverKop,
          windowBufferMin: bufferMin,
        }),
      () => setSaved(true),
    );
  }

  return (
    <Card className="space-y-4 p-4">
      <div className="grid gap-4 md:grid-cols-2">
        <label className="block md:col-span-2">
          <span className={label}>Название организации</span>
          <input aria-label="Название организации" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block">
          <span className={label}>Ставка НДС, %</span>
          <input aria-label="Ставка НДС, %" className={inputClass} inputMode="decimal" value={vat} onChange={(e) => setVat(e.target.value)} />
          <span className={hint}>С 1 января 2026 основная ставка — 22 %. Все расчёты ведутся без НДС.</span>
        </label>
        <label className="block">
          <span className={label}>Запас по окну, мин</span>
          <input aria-label="Запас по окну, мин" className={inputClass} inputMode="numeric" value={buffer} onChange={(e) => setBuffer(e.target.value)} />
          <span className={hint}>Прибытие позже, чем за столько минут до конца окна, считается риском.</span>
        </label>
        <label className="block">
          <span className={label}>Цена топлива, ₽ за литр</span>
          <input aria-label="Цена топлива, ₽ за литр" className={inputClass} inputMode="decimal" value={fuel} onChange={(e) => setFuel(e.target.value)} />
        </label>
        <label className="block">
          <span className={label}>Стоимость часа водителя, ₽</span>
          <input aria-label="Стоимость часа водителя, ₽" className={inputClass} inputMode="decimal" value={driver} onChange={(e) => setDriver(e.target.value)} />
        </label>
        <label className="block">
          <span className={label}>Расходы парка относятся на рейс</span>
          <select aria-label="Правило расходов парка" className={inputClass} value={fleetRule} onChange={(e) => setFleetRule(e.target.value as typeof fleetRule)}>
            <option value="days">по дням</option>
            <option value="km">по пробегу</option>
          </select>
        </label>
        <label className="block">
          <span className={label}>Ставка расходов парка, ₽ за {fleetRule === "days" ? "день" : "километр"}</span>
          <input aria-label="Ставка расходов парка" className={inputClass} inputMode="decimal" value={fleetRate} onChange={(e) => setFleetRate(e.target.value)} />
        </label>
        <label className="block">
          <span className={label}>Стоимость доставки по заказам распределяется</span>
          <select aria-label="База распределения доставки" className={inputClass} value={base} onChange={(e) => setBase(e.target.value as typeof base)}>
            <option value="pallets">по паллетам</option>
            <option value="weight">по весу</option>
          </select>
        </label>
      </div>
      <ErrorText>{error}</ErrorText>
      {saved && (
        <p data-testid="settings-saved" className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-green-800">
          Настройки сохранены
        </p>
      )}
      <Button disabled={pending} onClick={save}>
        Сохранить настройки
      </Button>
      <p className="text-xs text-gray-500">Изменения действуют на новые расчёты. Сохранённые планы не пересчитываются. Пример: {formatRub(7000)} за литр.</p>
    </Card>
  );
}

export function CreateUserForm() {
  const { error, pending, run } = useAction();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("logist");
  const [password, setPassword] = useState("");

  return (
    <Card className="space-y-3 p-4">
      <h3 className="font-medium">Новый пользователь</h3>
      <div className="grid gap-3 md:grid-cols-4">
        <label className="block">
          <span className="mb-1 block text-xs text-gray-500">Почта</span>
          <input aria-label="Почта пользователя" className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-gray-500">Имя</span>
          <input aria-label="Имя пользователя" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-gray-500">Роль</span>
          <select aria-label="Роль пользователя" className={inputClass} value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-gray-500">Пароль, не короче 8 знаков</span>
          <input aria-label="Пароль пользователя" type="password" autoComplete="new-password" className={inputClass} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
      </div>
      <ErrorText>{error}</ErrorText>
      <Button
        variant="secondary"
        disabled={pending}
        onClick={() =>
          run(() => createUserAction({ email, name, role, password }), () => {
            setEmail("");
            setName("");
            setPassword("");
          })
        }
      >
        Добавить пользователя
      </Button>
    </Card>
  );
}

export function UserActiveButton({ userId, active, self }: { userId: string; active: boolean; self: boolean }) {
  const { error, pending, run } = useAction();
  if (self) return <span className="text-xs text-gray-500">это вы</span>;
  return (
    <span>
      <Button variant={active ? "danger" : "secondary"} disabled={pending} onClick={() => run(() => setUserActiveAction(userId, !active))}>
        {active ? "Отключить" : "Включить"}
      </Button>
      {error && <span className="ml-2 text-xs text-red-700">{error}</span>}
    </span>
  );
}
