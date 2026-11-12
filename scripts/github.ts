#!/usr/bin/env node
// Stores the GitHub token the cron reads pull requests with (see src/github.ts), as the Worker's
// GITHUB_TOKEN secret. Optional: without it, every pull request counts as open.
//
//   npm run github
//
// A classic token with the `repo` scope: a fine-grained token reads one owner's repositories only,
// and a team's pull requests are often in more than one organisation. `repo` is the only classic scope
// that reads private repositories' pull requests, so it allows more than Cade does with it: Cade only
// asks whether each pull request is open, merged or closed. An organisation that uses SAML single
// sign-on also needs the token authorized for it (Configure SSO, on the token's page).
//
// The token is asked for hidden, checked with GitHub, and stored with `wrangler secret put`, never in
// a file.
import { fileURLToPath } from "node:url";
import { askHidden, confirm, log, openUrl } from "./prompt.ts";
import { putSecret } from "./slack-app.ts";

// GitHub's page for a new classic token, with the repo scope ticked and a name filled in.
export const NEW_TOKEN_URL = "https://github.com/settings/tokens/new?scopes=repo&description=Cade%20pull%20requests";

// What GitHub says of `token`: whose it is, or why Cade can't use it. A fine-grained token
// (github_pat_…) has no scopes to read, so it's let through with `narrow`, to warn that it reads one
// owner's repositories only.
export async function checkToken(token: string, fetcher: typeof fetch = fetch): Promise<{ login?: string; narrow?: boolean; problem?: string }> {
  const response = await fetcher("https://api.github.com/user", {
    headers: { authorization: `bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "Cade" },
  });
  if (response.status === 401) return { problem: "GitHub doesn't accept that token: check it was copied whole, and hasn't expired." };
  if (!response.ok) return { problem: `GitHub answered HTTP ${response.status}; try again in a moment.` };
  const body: unknown = await response.json();
  const login = typeof body === "object" && body !== null && "login" in body && typeof body.login === "string" ? body.login : "";
  if (token.startsWith("github_pat_")) return { login, narrow: true };
  const scopes = (response.headers.get("x-oauth-scopes") ?? "").split(",").map((scope) => scope.trim());
  if (!scopes.includes("repo")) return { problem: "That token doesn't have the repo scope, so it can't read private repositories' pull requests. Make one with repo ticked." };
  return { login };
}

async function main() {
  log.info(
    [
      "With a GitHub token, Cade reads every 15 minutes whether each pull request linked to an open task is open, merged or closed, and the task's card counts them.",
      "Without one, every pull request counts as open.",
      "Make a classic token with the repo scope (it reads every organisation your account can, where a fine-grained token reads one), with no expiry or a long one.",
      "If an organisation uses SAML single sign-on, authorize the token for it: Configure SSO, on the token's page.",
    ].join("\n"),
  );
  console.log(`  ${NEW_TOKEN_URL}`);
  if (await confirm("Open GitHub's page for a new token, with repo ticked?")) openUrl(NEW_TOKEN_URL);
  const token = await askHidden("GitHub token (ghp_…, hidden), or press Enter to skip: ");
  if (!token) {
    console.log("Skipped: every pull request counts as open. Add one any time with npm run github.");
    return;
  }
  const checked = await checkToken(token);
  if (checked.problem) throw new Error(checked.problem);
  if (checked.narrow) log.warn("That's a fine-grained token: it reads one owner's repositories only, and pull requests elsewhere count as open.");
  await putSecret("GITHUB_TOKEN", token);
  console.log(`Stored. Cade reads pull requests as ${checked.login || "that account"} from the cron's next run.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
