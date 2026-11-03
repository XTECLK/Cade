import { loginLink } from "../web.js";

// `/cade login` gives the person a link, shown only to them, that signs them
// in to the Worker's pages for a task's thread and notes (see web.js): the
// link works once, for ten minutes, and sets a cookie that lasts thirty days.
export default {
  name: "login",
  description: "Sign in to the pages for a task's full history and notes: gives you a private link",
  slashUsage: ["/cade login"],
  section: "work",
  async slash(command, { env }) {
    const link = await loginLink(env, command.user);
    return `:key: <${link}|Sign in to Cade's pages>. The link works once, for ten minutes, and keeps you signed in on that browser for thirty days. After that, the "Full history" and "Extra notes" links on task cards open for you in any channel you can read.`;
  },
};
