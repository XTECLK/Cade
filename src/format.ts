import { callSlack } from "./slack.ts";
import type { AppEnv } from "./env.ts";

// Returns display names for Slack user IDs, joined with commas. Needs the
// users:read scope; without it, the IDs themselves are used.
export async function userNames(env: AppEnv, ids: string[]) {
  const names = await Promise.all(
    ids.map(async (id) => {
      try {
        const { user } = await callSlack(env, "users.info", { user: id });
        return user.profile?.display_name || user.real_name || user.name || id;
      } catch (error) {
        console.warn("Could not look up user", { id, error: error.message });
        return id;
      }
    }),
  );
  return names.join(", ");
}

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
