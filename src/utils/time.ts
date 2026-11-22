export function nowIso(): string {
  return new Date().toISOString();
}

export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * YYYY-MM-DD in a time zone, assembled from date parts.
 *
 * `Intl.DateTimeFormat(locale).format()` only renders an ISO-shaped string when the
 * runtime ships full ICU data for that locale. Node builds with small-icu (and any
 * runtime missing `en-CA`) fall back to `en`, which renders `M/D/YYYY`. Every date
 * *label* in this repo is compared and parsed as `YYYY-MM-DD`, so labels are built
 * from `formatToParts` instead of trusting the locale's rendering.
 */
export function formatDateLabel(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}
