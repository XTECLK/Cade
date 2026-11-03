// The addresses of the Worker's own pages for a task: its thread, `/t/…`, and
// its notes, `/n/…` (see web.js). They are built on the Worker's address,
// `PUBLIC_URL`, which a request fills in from the one it came by when it isn't
// set (see index.js), so there are none where neither is known, such as in the
// cron; the card then shows no link until a `/cade resync` makes one.
export function publicUrl(env) {
  return (env.PUBLIC_URL ?? "").replace(/\/+$/, "");
}

export function threadUrl(env, channel, ts) {
  const base = publicUrl(env);
  return base ? `${base}/t/${channel}/${ts}` : "";
}

export function notesUrl(env, channel, ts) {
  const base = publicUrl(env);
  return base ? `${base}/n/${channel}/${ts}` : "";
}
