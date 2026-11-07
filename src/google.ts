// Each group's Google Doc (its executive summaries, see doc.ts) is written
// through one Apps Script web app (google/Code.gs), a standalone script serving
// every group: GOOGLE_URL, with GOOGLE_SECRET. Each request names its `action`.
import type { AppEnv } from "./env.ts";

type GoogleEnv = Pick<AppEnv, "GOOGLE_URL" | "GOOGLE_SECRET">;

export function googleEnabled(env: GoogleEnv) {
  return Boolean(env.GOOGLE_URL && env.GOOGLE_SECRET);
}

// Sends `request` ({ action, … }) to the web app and returns its reply, or
// throws. Apps Script runs doPost before answering, then redirects to a page
// that holds its reply, which is followed here. On some Google accounts that
// page returns 404 even though doPost completed; with `lenient`, for what
// needs no reply, the redirect then counts as done.
export async function callGoogle(env: GoogleEnv, request: { action: string; [key: string]: unknown }, { lenient = false } = {}): Promise<{ [key: string]: any }> {
  const response = await fetch(env.GOOGLE_URL!, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: env.GOOGLE_SECRET, ...request }),
    redirect: "manual",
  });
  let reply: Response | null = response;
  if (response.status === 302) {
    reply = await fetch(response.headers.get("location")!).catch(() => null);
    const isJson = reply?.ok && reply.headers.get("content-type")?.includes("json");
    if (!isJson && lenient) return {};
  }
  if (!reply?.ok) throw new Error(`Google web app returned HTTP ${reply?.status ?? "nothing"}`);
  const result = await reply.json<any>();
  if (!result.ok) throw new Error(`Google web app refused ${request.action}: ${result.error}`);
  return result;
}
