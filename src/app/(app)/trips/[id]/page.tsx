import Link from "next/link";
import { notFound } from "next/navigation";
import { TripStatusBadge } from "@/components/StatusBadges";
import { PageHeader } from "@/components/ui";
import { isDomainError } from "@/domain/errors";
import { can } from "@/domain/permissions";
import { requireCtx } from "@/server/auth/requireCtx";
import { getTrip } from "@/server/services/trips";
import { AcceptanceTab } from "./AcceptanceTab";
import { DocumentsTab } from "./DocumentsTab";
import { ExecutionTab } from "./ExecutionTab";
import { HistoryTab } from "./HistoryTab";
import { MoneyTab } from "./MoneyTab";
import { PlanTab } from "./PlanTab";

/** Tabs of the trip card; later modules add theirs here. */
const TABS = [
  { key: "plan", label: "План", needs: "trips.read" },
  { key: "execution", label: "Исполнение", needs: "trips.read" },
  { key: "acceptance", label: "Приёмка", needs: "trips.read" },
  { key: "money", label: "Деньги", needs: "money.read" },
  { key: "documents", label: "Документы", needs: "trips.read" },
  { key: "history", label: "История", needs: "trips.read" },
] as const;

export default async function TripPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab } = await searchParams;
  const ctx = await requireCtx();
  const trip = await getTrip(ctx, id).catch((e: unknown) => {
    if (isDomainError(e) && (e.code === "not_found" || e.code === "validation")) notFound();
    throw e;
  });
  // A tab the role may not open is neither shown nor reachable by its address.
  const tabs = TABS.filter((t) => can(ctx.actor.role, t.needs));
  const active = tabs.find((t) => t.key === tab)?.key ?? tabs[0].key;

  return (
    <>
      <PageHeader title={`Рейс ${trip.number}`}>
        <span data-testid="trip-status-badge">
          <TripStatusBadge status={trip.status} />
        </span>
        <Link href="/trips" className="text-blue-700 hover:underline">
          К списку
        </Link>
      </PageHeader>
      {trip.cancelReason && <p className="mb-4 text-red-700">Отменён: {trip.cancelReason}</p>}

      <div className="mb-4 flex gap-1 border-b border-gray-200">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={`/trips/${id}?tab=${t.key}`}
            className={`-mb-px border-b-2 px-3 py-2 ${
              t.key === active ? "border-blue-600 font-medium text-blue-700" : "border-transparent text-gray-600 hover:text-gray-900"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {active === "plan" && <PlanTab ctx={ctx} trip={trip} />}
      {active === "execution" && <ExecutionTab ctx={ctx} trip={trip} />}
      {active === "acceptance" && <AcceptanceTab ctx={ctx} trip={trip} />}
      {active === "money" && <MoneyTab ctx={ctx} trip={trip} />}
      {active === "documents" && <DocumentsTab ctx={ctx} trip={trip} />}
      {active === "history" && <HistoryTab ctx={ctx} trip={trip} />}
    </>
  );
}
