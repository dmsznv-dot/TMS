"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { addOfferAction, setOfferStatusAction } from "@/app/actions/planning";
import { Badge, Button, Card, ErrorText, inputClass } from "@/components/ui";
import { formatRub, parseRub } from "@/domain/money";
import { formatInTz } from "@/domain/time";
import type { OfferStatus, OfferView } from "@/server/services/offers";
import type { CounterpartyRow } from "@/server/services/refs";

export const OFFER_STATUS_LABELS: Record<OfferStatus, string> = {
  candidate: "Кандидат",
  quoted: "Ставка получена",
  confirmed: "Подтверждён",
  rejected: "Отклонён",
};

const TONES: Record<OfferStatus, "gray" | "blue" | "green" | "red"> = { candidate: "gray", quoted: "blue", confirmed: "green", rejected: "red" };

/** Offers of carriers for one trip, entered by hand from calls and messages. */
export function OffersPanel({
  tripId,
  tz,
  carriers,
  offers,
  canEdit,
}: {
  tripId: string;
  tz: string;
  carriers: CounterpartyRow[];
  offers: OfferView[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [carrierId, setCarrierId] = useState(carriers[0]?.id ?? "");
  const [rate, setRate] = useState("");
  const [vatIncluded, setVatIncluded] = useState(true);
  const [arrive, setArrive] = useState("");
  const [vehicleDescr, setVehicleDescr] = useState("");
  const [terms, setTerms] = useState("");
  const [downtime, setDowntime] = useState("");
  const [source, setSource] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function add() {
    setError(null);
    const rateKop = rate.trim() ? parseRub(rate) : null;
    if (rate.trim() && rateKop == null) return setError("Ставка — число в рублях");
    const downtimeKop = downtime.trim() ? parseRub(downtime) : 0;
    if (downtimeKop == null) return setError("Простой — число в рублях");
    startTransition(async () => {
      const result = await addOfferAction({
        tripId,
        carrierId,
        rateKop,
        vatIncluded,
        vehicleDescr: vehicleDescr.trim() || null,
        confirmedArriveLocal: arrive || null,
        downtimeTerms: terms.trim() || null,
        expectedDowntimeKop: downtimeKop,
        source: source.trim() || null,
      });
      if (!result.ok) return setError(result.message);
      setOpen(false);
      setRate("");
      router.refresh();
    });
  }

  function setStatus(offerId: string, status: OfferStatus) {
    setError(null);
    startTransition(async () => {
      const result = await setOfferStatusAction(tripId, offerId, status);
      if (!result.ok) return setError(result.message);
      router.refresh();
    });
  }

  return (
    <section aria-label="Предложения подрядчиков" className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Подрядчики</h2>
        {canEdit && !open && (
          <Button variant="secondary" onClick={() => setOpen(true)} disabled={carriers.length === 0}>
            Добавить предложение
          </Button>
        )}
      </div>
      {carriers.length === 0 && canEdit && <p className="text-xs text-gray-500">Добавьте перевозчика в справочнике «Контрагенты».</p>}

      {offers.map((o) => (
        <Card key={o.id} className="space-y-1 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">{o.carrierName}</span>
            <Badge tone={TONES[o.status]}>{OFFER_STATUS_LABELS[o.status]}</Badge>
          </div>
          <div className="text-gray-700">
            {o.rateKop != null ? `${formatRub(o.rateKop)} ${o.vatIncluded ? "с НДС" : "без НДС"}` : "Ставка не получена"}
            {o.confirmedArriveAt && `, подтверждает ${formatInTz(o.confirmedArriveAt, tz, "dd.MM HH:mm")}`}
          </div>
          {(o.vehicleDescr || o.downtimeTerms || o.source) && (
            <div className="text-xs text-gray-500">{[o.vehicleDescr, o.downtimeTerms, o.source && `источник: ${o.source}`].filter(Boolean).join(" · ")}</div>
          )}
          {canEdit && (
            <label className="flex items-center gap-2 text-xs">
              Состояние
              <select aria-label={`Состояние предложения ${o.carrierName}`} className={`${inputClass} w-auto`} value={o.status} disabled={pending} onChange={(e) => setStatus(o.id, e.target.value as OfferStatus)}>
                {(Object.keys(OFFER_STATUS_LABELS) as OfferStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {OFFER_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
          )}
        </Card>
      ))}

      {open && (
        <Card className="space-y-3 p-3">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block">
              <span className="mb-1 block font-medium">Перевозчик</span>
              <select className={inputClass} value={carrierId} onChange={(e) => setCarrierId(e.target.value)}>
                {carriers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block font-medium">Ставка, ₽</span>
              <input className={inputClass} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={vatIncluded} onChange={(e) => setVatIncluded(e.target.checked)} />
              <span>Ставка с НДС</span>
            </label>
            <label className="block">
              <span className="mb-1 block font-medium">Подтверждает прибытие</span>
              <input type="datetime-local" className={inputClass} value={arrive} onChange={(e) => setArrive(e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block font-medium">Машина</span>
              <input className={inputClass} value={vehicleDescr} onChange={(e) => setVehicleDescr(e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block font-medium">Источник</span>
              <input className={inputClass} value={source} onChange={(e) => setSource(e.target.value)} placeholder="звонок, переписка…" />
            </label>
            <label className="block">
              <span className="mb-1 block font-medium">Условия простоя</span>
              <input className={inputClass} value={terms} onChange={(e) => setTerms(e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block font-medium">Ожидаемый простой, ₽</span>
              <input className={inputClass} inputMode="decimal" value={downtime} onChange={(e) => setDowntime(e.target.value)} />
            </label>
          </div>
          <ErrorText>{error}</ErrorText>
          <div className="flex gap-2">
            <Button onClick={add} disabled={pending}>
              Сохранить предложение
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Отмена
            </Button>
          </div>
        </Card>
      )}
      {!open && <ErrorText>{error}</ErrorText>}
    </section>
  );
}
