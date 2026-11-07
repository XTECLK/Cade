// A call to the Google web app (google/Code.gs): { secret, action, … } in,
// { ok, … } out. Apps Script answers a POST with a redirect to the page that
// holds the reply, which is followed here.
export async function callWebApp(url, secret, action, body = {}, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret, action, ...body }),
    redirect: "manual",
  });
  const reply = response.status === 302 ? await fetchImpl(response.headers.get("location")) : response;
  return reply.json().catch(() => ({ ok: false, error: `HTTP ${reply.status}` }));
}

// The secret in Secret.gs's text (`const SECRET = "…";`), or undefined.
export function secretIn(text) {
  return /const SECRET = "([0-9a-f]+)"/.exec(text)?.[1];
}
