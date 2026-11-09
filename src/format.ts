import type { AppEnv } from "./env.ts";

// Formats a date as DD/MM/YYYY HH:MM in TIMEZONE (UTC by default).
export function formatTime(env: Pick<AppEnv, "TIMEZONE">, date: Date | number) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: env.TIMEZONE || "UTC",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
}
