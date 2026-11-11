import { formatInTz } from "@/domain/time";
import type { Quota } from "@/server/routing/quota";
import { Badge } from "./ui";

/** Shows which calculation is used and how much of the 2GIS limit is spent. */
export function QuotaBadge({ quota }: { quota: Quota }) {
  if (!quota.live) {
    return (
      <span data-testid="quota-badge">
        <Badge>Демо-расчёт, не 2ГИС</Badge>
      </span>
    );
  }
  const left = quota.limit - quota.used;
  return (
    <span data-testid="quota-badge" className="inline-flex flex-wrap items-center gap-2">
      <Badge tone={left <= 0 ? "red" : left < 100 ? "amber" : "blue"}>
        2ГИС: использовано {quota.used} из {quota.limit}
      </Badge>
      {quota.expiresAt && <span className="text-xs text-gray-500">ключ до {formatInTz(quota.expiresAt, "Europe/Moscow", "dd.MM.yyyy")}</span>}
    </span>
  );
}
