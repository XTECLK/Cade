// The address of the Worker's own page for a task: its thread, `/t/…` (see
// web.ts). It is built on the Worker's address, `PUBLIC_URL`, which a request
// fills in from the one it came by when it isn't set (see index.ts), so there
// is none where neither is known, such as in the cron; the card then shows no
// link until a `/cade resync` makes one.
import type { AppEnv } from "./env.ts";

export function publicUrl(env: Pick<AppEnv, "PUBLIC_URL">) {
  return (env.PUBLIC_URL ?? "").replace(/\/+$/, "");
}

export function threadUrl(env: Pick<AppEnv, "PUBLIC_URL">, channel: string, ts: string) {
  const base = publicUrl(env);
  return base ? `${base}/t/${channel}/${ts}` : "";
}
