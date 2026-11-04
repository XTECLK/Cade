import { deleteWebTokensOf } from "../db.js";
import { loginLink } from "../web.js";

// `/cade web login` and `/cade web logout` start and end the person's sign-in to the Worker's
// pages (see web.js): the thread and notes pages that task cards link to. `login` gives a link; `logout` ends every browser session of theirs and any
// sign-in link they hadn't used, so a lost laptop or a shared computer can be signed out from Slack.
export default {
  name: "web",
  description: "Sign in to or out of Cade's web pages: `login` gives you a private link, `logout` signs you out of every browser",
  slashUsage: ["/cade web login", "/cade web logout"],
  section: "work",
  async slash(command, { env }) {
    const action = command.text.trim().toLowerCase();
    if (action === "logout") {
      const sessions = await deleteWebTokensOf(env, command.user);
      return sessions
        ? `:wave: Signed out of ${sessions} browser session${sessions === 1 ? "" : "s"}. \`/cade web login\` signs you in again.`
        : "You weren't signed in to Cade's pages in any browser. Any sign-in link you hadn't used is cancelled too.";
    }
    if (action === "login") {
      return `:key: <${await loginLink(env, command.user)}|Sign in to Cade's pages>. The link works once, for ten minutes, and keeps you signed in on that browser for thirty days. After that, the "Full history" and "Extra notes" links on task cards open for you in any channel you can read.`;
    }
    return "Send `/cade web login` to sign in to Cade's pages, or `/cade web logout` to sign out of every browser.";
  },
};
