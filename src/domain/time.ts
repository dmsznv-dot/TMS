import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * Converts wall-clock time at a point ("2026-11-12T14:00") to a UTC instant.
 * Throws when the text is not in that form.
 */
export function zonedToUtc(local: string, tz: string): Date {
  const match = LOCAL.exec(local);
  if (!match) throw new Error(`Not a local date-time: ${local}`);
  const [, y, mo, d, h, mi] = match.map(Number);
  return new Date(new TZDate(y, mo - 1, d, h, mi, tz).getTime());
}

/** Formats a UTC instant as wall-clock time in the given zone. */
export function formatInTz(date: Date, tz: string, pattern: string): string {
  return format(new TZDate(date.getTime(), tz), pattern);
}
