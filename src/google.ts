// Each group's Google Doc (its executive summaries, see doc.ts) is written
// through one Apps Script web app (google/Code.gs), a standalone script serving
// every group: GOOGLE_URL, with GOOGLE_SECRET. Each request names its `action`.
import type { AppEnv } from "./env.ts";
import type { DocElement } from "./doc.ts";

type GoogleEnv = Pick<AppEnv, "GOOGLE_URL" | "GOOGLE_SECRET">;

// What Cade reads of the web app's reply to each action (see google/Code.gs).
export interface GoogleAnswers {
  // The address of the tab written.
  "doc.write": { url: string };
  // The section as it reads now, or none if it is gone.
  "doc.read": { elements?: DocElement[] };
  // The new doc's ID.
  "doc.create": { id: string };
}

export function googleEnabled(env: GoogleEnv) {
  return Boolean(env.GOOGLE_URL && env.GOOGLE_SECRET);
}

// Sends `request` ({ action, … }) to the web app and returns its reply, or
// throws. Apps Script runs doPost before answering, then redirects to a page
// that holds its reply, which is followed here. On some Google accounts that
// page returns 404 even though doPost completed; with `lenient`, for what
// needs no reply, the redirect then counts as done.
export async function callGoogle<A extends keyof GoogleAnswers>(
  env: GoogleEnv,
  request: { action: A; [key: string]: unknown },
  { lenient = false } = {},
): Promise<GoogleAnswers[A]> {
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
    // Only for an action whose reply isn't read, so there is nothing in it to miss.
    if (!isJson && lenient) return {} as GoogleAnswers[A];
  }
  if (!reply?.ok) throw new Error(`Google web app returned HTTP ${reply?.status ?? "nothing"}`);
  const result = await reply.json<{ ok: boolean; error?: string }>();
  if (!result.ok) throw new Error(`Google web app refused ${request.action}: ${result.error}`);
  // The web app's reply for the action: GoogleAnswers says which of its fields Cade reads.
  return result as unknown as GoogleAnswers[A];
}
