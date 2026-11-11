import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { DomainError } from "@/domain/errors";
import { requireCan, type Ctx } from "../auth/context";
import { carrierOffers, counterparties, trips } from "../db/schema";
import { audit, inTransaction } from "./audit";
import { getOrgSettings } from "./users";
import { parseInput } from "./validation";

export type OfferStatus = "candidate" | "quoted" | "confirmed" | "rejected";

const text = z.string().trim().min(1).nullish();

export const offerInput = z.object({
  tripId: z.uuid(),
  carrierId: z.uuid(),
  rateKop: z.number().int().positive("Ставка должна быть больше нуля").nullish(),
  vatIncluded: z.boolean().default(true),
  vehicleDescr: text,
  confirmedArriveAt: z.date().nullish(),
  downtimeTerms: text,
  expectedDowntimeKop: z.number().int().nonnegative().default(0),
  validUntil: z.date().nullish(),
  source: text,
  status: z.enum(["candidate", "quoted", "confirmed"]).optional(),
});

export type OfferView = {
  id: string;
  tripId: string;
  carrierId: string;
  carrierName: string;
  rateKop: number | null;
  vatIncluded: boolean;
  vatRateBp: number;
  vehicleDescr: string | null;
  confirmedArriveAt: Date | null;
  downtimeTerms: string | null;
  expectedDowntimeKop: number;
  validUntil: Date | null;
  source: string | null;
  status: OfferStatus;
  createdAt: Date;
};

function needsRate(status: OfferStatus, rateKop: number | null | undefined): void {
  if ((status === "quoted" || status === "confirmed") && rateKop == null) {
    throw new DomainError("rate_required", "Укажите ставку: без неё предложение нельзя считать полученным");
  }
}

/** Records what a carrier offered, from a call, a message or a search result. */
export async function addCarrierOffer(
  ctx: Ctx,
  input: z.input<typeof offerInput>,
): Promise<{ offerId: string }> {
  requireCan(ctx, "planning.write");
  const data = parseInput(offerInput, input);
  const status: OfferStatus = data.status ?? (data.rateKop != null ? "quoted" : "candidate");
  needsRate(status, data.rateKop);

  return inTransaction(ctx, async (tx) => {
    const [trip] = await tx.db
      .select({ status: trips.status })
      .from(trips)
      .where(and(eq(trips.id, data.tripId), eq(trips.orgId, tx.orgId)));
    if (!trip) throw new DomainError("not_found", "Рейс не найден");
    if (trip.status === "closed" || trip.status === "cancelled") {
      throw new DomainError("trip_locked", "К закрытому или отменённому рейсу предложения не добавляются");
    }

    const [carrier] = await tx.db
      .select({ kind: counterparties.kind })
      .from(counterparties)
      .where(and(eq(counterparties.id, data.carrierId), eq(counterparties.orgId, tx.orgId)));
    if (!carrier) throw new DomainError("not_found", "Перевозчик не найден");
    if (carrier.kind !== "carrier") throw new DomainError("validation", "Выбранный контрагент не перевозчик");

    const settings = await getOrgSettings(tx);
    const [row] = await tx.db
      .insert(carrierOffers)
      .values({
        orgId: tx.orgId,
        tripId: data.tripId,
        carrierId: data.carrierId,
        rateKop: data.rateKop ?? null,
        vatIncluded: data.vatIncluded,
        vatRateBp: settings.vatRateBp,
        vehicleDescr: data.vehicleDescr ?? null,
        confirmedArriveAt: data.confirmedArriveAt ?? null,
        downtimeTerms: data.downtimeTerms ?? null,
        expectedDowntimeKop: data.expectedDowntimeKop,
        validUntil: data.validUntil ?? null,
        source: data.source ?? null,
        status,
      })
      .returning({ id: carrierOffers.id });
    await audit(tx, { entity: "carrier_offer", entityId: row.id, action: "create", after: { tripId: data.tripId, status, rateKop: data.rateKop } });
    return { offerId: row.id };
  });
}

export async function setOfferStatus(ctx: Ctx, input: { offerId: string; status: OfferStatus }): Promise<void> {
  requireCan(ctx, "planning.write");
  await inTransaction(ctx, async (tx) => {
    const [offer] = await tx.db
      .select()
      .from(carrierOffers)
      .where(and(eq(carrierOffers.id, input.offerId), eq(carrierOffers.orgId, tx.orgId)))
      .for("update");
    if (!offer) throw new DomainError("not_found", "Предложение не найдено");
    needsRate(input.status, offer.rateKop);
    await tx.db.update(carrierOffers).set({ status: input.status }).where(eq(carrierOffers.id, offer.id));
    await audit(tx, { entity: "carrier_offer", entityId: offer.id, action: "status", before: { status: offer.status }, after: { status: input.status } });
  });
}

/** Offers of a trip with carrier names. The caller has already checked access. */
export async function loadOffers(ctx: Ctx, tripId: string): Promise<OfferView[]> {
  const rows = await ctx.db
    .select({ offer: carrierOffers, carrierName: counterparties.name })
    .from(carrierOffers)
    .innerJoin(counterparties, eq(counterparties.id, carrierOffers.carrierId))
    .where(and(eq(carrierOffers.tripId, tripId), eq(carrierOffers.orgId, ctx.orgId)))
    .orderBy(asc(carrierOffers.createdAt));
  return rows.map(({ offer, carrierName }) => ({
    id: offer.id,
    tripId: offer.tripId,
    carrierId: offer.carrierId,
    carrierName,
    rateKop: offer.rateKop,
    vatIncluded: offer.vatIncluded,
    vatRateBp: offer.vatRateBp,
    vehicleDescr: offer.vehicleDescr,
    confirmedArriveAt: offer.confirmedArriveAt,
    downtimeTerms: offer.downtimeTerms,
    expectedDowntimeKop: offer.expectedDowntimeKop,
    validUntil: offer.validUntil,
    source: offer.source,
    status: offer.status,
    createdAt: offer.createdAt,
  }));
}

export async function listOffers(ctx: Ctx, tripId: string): Promise<OfferView[]> {
  requireCan(ctx, "money.read");
  return loadOffers(ctx, tripId);
}
