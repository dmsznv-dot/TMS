import { COMPLETENESS_LABELS_SHORT } from "./completeness";
import { EXPENSE_LABELS, type ExpenseCategory } from "./costEstimate";
import { formatRub } from "./money";
import { formatQty } from "./qty";
import { TRIP_STATUS_LABELS, type TripStatus } from "./tripStatus";

type Entry = { entity: string; action: string; before?: unknown; after?: unknown };
type Bag = Record<string, unknown>;

const bag = (v: unknown): Bag => (typeof v === "object" && v !== null ? (v as Bag) : {});
const tripStatus = (s: unknown) => TRIP_STATUS_LABELS[s as TripStatus] ?? String(s ?? "—");
const category = (c: unknown) => EXPENSE_LABELS[c as ExpenseCategory] ?? String(c ?? "—");

const EVENTS: Record<string, string> = {
  driver_confirmed: "водитель подтвердил назначение",
  loading_started: "начата погрузка",
  loaded: "погружен",
  departed: "выехал",
  arrived: "прибыл",
  unloaded: "разгружен",
  stop_skipped: "остановка не состоялась",
  completed: "рейс завершён",
  fact_entered: "факт внесён вручную",
};
const OFFER_STATUS: Record<string, string> = { candidate: "Кандидат", quoted: "Ставка получена", confirmed: "Подтверждён", rejected: "Отклонён" };

/** A readable line for an entry of the audit log. Unknown entries are shown by their raw names. */
export function describeAudit(e: Entry): string {
  const before = bag(e.before);
  const after = bag(e.after);

  if (e.entity === "trip") {
    if (e.action === "status") {
      const reason = after.cancelReason ? `. Причина: ${after.cancelReason}` : "";
      return `Статус: ${tripStatus(before.status)} → ${tripStatus(after.status)}${reason}`;
    }
    if (e.action === "close_override") {
      const failed = (Array.isArray(after.failed) ? after.failed : []) as string[];
      const missing = failed.map((c) => COMPLETENESS_LABELS_SHORT[c as keyof typeof COMPLETENESS_LABELS_SHORT] ?? c).join("; ");
      return `Закрыт с исключением. Причина: ${after.reason}${missing ? `. Не хватало: ${missing}` : ""}`;
    }
    if (e.action.startsWith("event:")) return `Отметка: ${EVENTS[e.action.slice(6)] ?? e.action.slice(6)}`;
    if (e.action === "create") return "Рейс создан";
    if (e.action === "add_cargo") return "В рейс добавлен груз";
    if (e.action === "remove_cargo") return "Из рейса убран груз";
    if (e.action === "reorder_stops") return "Изменён порядок остановок";
    if (e.action === "confirm_loading") return "Подтверждена погрузка";
    if (e.action === "mileage") return "Внесён пробег";
  }
  if (e.entity === "plan_version" && e.action === "create") {
    const who = after.executor === "own" ? "своя машина" : "подрядчик";
    return `План: версия ${after.versionNo}, ${who}${after.reason ? `. Причина: ${after.reason}` : ""}`;
  }
  if (e.entity === "share_link") return e.action === "revoke" ? "Ссылка для водителя отозвана" : "Создана ссылка для водителя";
  if (e.entity === "carrier_offer") {
    if (e.action === "status") return `Предложение подрядчика: ${OFFER_STATUS[String(before.status)] ?? before.status} → ${OFFER_STATUS[String(after.status)] ?? after.status}`;
    if (e.action === "create") return "Добавлено предложение подрядчика";
  }
  if (e.entity === "acceptance" && e.action === "record") return `Приёмка: версия ${after.versionNo}, принято ${formatQty(Number(after.accepted ?? 0))}`;
  if (e.entity === "trip_stop" && e.action === "fact") return "Внесено фактическое время остановки";
  if (e.entity === "expense") {
    if (e.action === "create") return `Расход: ${category(after.category)}, ${formatRub(Number(after.amountKop ?? 0))}`;
    if (e.action === "verify") return "Расход проверен";
    if (e.action === "not_incurred") return `Отмечено, что расхода не было: ${category(after.category)}`;
    if (e.action === "link") return "Расход привязан к рейсу";
  }
  if (e.entity === "accrual" && e.action === "create") {
    return `Начисление (${after.kind === "surcharge" ? "доплата" : "выручка"}): ${formatRub(Number(after.amountKop ?? 0))}`;
  }
  if (e.entity === "invoice" && e.action === "create") return `Счёт № ${after.number} на ${formatRub(Number(after.amountKop ?? 0))}`;
  if (e.entity === "payment" && e.action === "allocate") return `Оплата разнесена: ${formatRub(Number(after.amountKop ?? 0))}`;
  if (e.entity === "document") {
    if (e.action === "create") return `Документ: ${after.kind}`;
    if (e.action === "status") return "Изменён статус документа";
  }
  if (e.entity === "task") return e.action === "complete" ? "Задача закрыта" : `Задача: ${after.title ?? "создана"}`;
  return `${e.entity}: ${e.action}`;
}
