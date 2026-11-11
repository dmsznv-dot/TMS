import { PageHeader } from "@/components/ui";
import { isDomainError } from "@/domain/errors";
import { can } from "@/domain/permissions";
import { formatInTz } from "@/domain/time";
import { requireCtx } from "@/server/auth/requireCtx";
import { env } from "@/server/env";
import { getQuota } from "@/server/routing/quota";
import { listOffers } from "@/server/services/offers";
import { listOrders } from "@/server/services/orders";
import { listPlanVersions } from "@/server/services/planning";
import { listCounterparties, listDrivers, listLocations, listVehicles } from "@/server/services/refs";
import { getTrip, listTrips, type TripView } from "@/server/services/trips";
import { OffersPanel } from "./OffersPanel";
import { OrderQueue } from "./OrderQueue";
import { RoutePanel } from "./RoutePanel";
import { TripPanel } from "./TripPanel";

const ACTIVE = ["draft", "planned", "assigned"];

/** Wall-clock "yyyy-MM-ddTHH:mm" an hour and a half before the earliest delivery window opens. */
function defaultDeparture(trip: TripView): string {
  const tz = trip.stops[0].location.tz;
  const opens = trip.stops.flatMap((s) => (s.windowStart ? [s.windowStart.getTime()] : []));
  const base = opens.length > 0 ? new Date(Math.min(...opens) - 90 * 60_000) : new Date(Date.now() + 24 * 3600_000);
  return formatInTz(base, tz, "yyyy-MM-dd'T'HH:mm");
}

export default async function PlanningPage({ searchParams }: { searchParams: Promise<{ trip?: string }> }) {
  const ctx = await requireCtx();
  const { trip: tripId } = await searchParams;
  const role = ctx.actor.role;
  const canPlan = can(role, "planning.write");
  const canMoney = can(role, "money.read");

  let trip: TripView | null = null;
  if (tripId) {
    trip = await getTrip(ctx, tripId).catch((e: unknown) => {
      if (isDomainError(e) && (e.code === "not_found" || e.code === "validation")) return null;
      throw e;
    });
  }

  const [allOrders, allTrips, locations] = await Promise.all([
    listOrders(ctx),
    listTrips(ctx),
    listLocations(ctx, { activeOnly: true }),
  ]);
  const orders = allOrders.filter((o) => o.status !== "cancelled" && o.lines.some((l) => l.remainingMilli > 0));
  const trips = allTrips.filter((t) => ACTIVE.includes(t.status) || t.id === trip?.id);
  const origins = locations.filter((l) => l.kind === "warehouse" || l.kind === "dc").map((l) => ({ id: l.id, name: l.name }));

  const [quota, vehicles, drivers, carriers, offers, versions] = await Promise.all([
    getQuota(ctx),
    canPlan ? listVehicles(ctx, { activeOnly: true }) : [],
    canPlan ? listDrivers(ctx, { activeOnly: true }) : [],
    canPlan ? listCounterparties(ctx, { kind: "carrier", activeOnly: true }) : [],
    canMoney && trip ? listOffers(ctx, trip.id) : [],
    canMoney && trip ? listPlanVersions(ctx, trip.id) : [],
  ]);

  const current = versions.find((v) => v.isCurrent);
  const plan = current
    ? {
        versionNo: current.versionNo,
        executorLabel: current.executor === "own" ? `${current.vehicle?.plate ?? "?"}, ${current.driver?.name ?? "?"}` : `подрядчик ${current.offer?.carrierName ?? "?"}`,
        totalKop: current.totalKop,
      }
    : null;

  return (
    <>
      <PageHeader title="Планирование" />
      <div className="grid gap-6 xl:grid-cols-[23rem_minmax(0,1fr)]">
        <div className="space-y-6">
          <TripPanel trip={trip} trips={trips} origins={origins} canPlan={canPlan} />
          {trip && canMoney && (
            <OffersPanel tripId={trip.id} tz={trip.stops[0].location.tz} carriers={carriers} offers={offers} canEdit={canPlan} />
          )}
          <OrderQueue orders={orders} trip={trip ? { id: trip.id, version: trip.version, status: trip.status } : null} canPlan={canPlan} />
        </div>

        <div className="min-w-0">
          {canPlan && trip ? (
            <RoutePanel
              trip={trip}
              vehicles={vehicles}
              drivers={drivers}
              offers={offers}
              quota={quota}
              plan={plan}
              defaultDeparture={defaultDeparture(trip)}
              tileUrl={env.MAP_TILE_URL}
            />
          ) : (
            <p className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-gray-500">
              {canPlan ? "Выберите рейс или создайте новый: здесь появятся карта, маршрут и исполнители." : "У вашей роли доступен просмотр. Планируют рейсы логисты."}
            </p>
          )}
        </div>
      </div>
    </>
  );
}
