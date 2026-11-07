// The web app's reply: ok, and what the action gives, or why it failed.
export type WebAppReply = { ok: boolean; error?: string; [key: string]: any };

// A call to the Google web app (google/Code.gs): { secret, action, … } in,
// { ok, … } out. Apps Script answers a POST with a redirect to the page that
// holds the reply, which is followed here.
export async function callWebApp(url: string, secret: string | undefined, action: string, body = {}, fetchImpl: (url: string, init?: RequestInit) => Promise<Pick<Response, "status" | "headers" | "json">> = fetch): Promise<WebAppReply> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret, action, ...body }),
    redirect: "manual",
  });
  const reply = response.status === 302 ? await fetchImpl(response.headers.get("location")!) : response;
  return (reply.json() as Promise<WebAppReply>).catch(() => ({ ok: false, error: `HTTP ${reply.status}` }));
}

// The secret in Secret.gs's text (`const SECRET = "…";`), or undefined.
export function secretIn(text) {
  return /const SECRET = "([0-9a-f]+)"/.exec(text)?.[1];
}
