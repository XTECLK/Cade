import { setHomeProject, setSuggestions } from "../db.ts";
import { CLAIM_ACTION, CONFIGURE, CONFIGURE_ACTION, HOME_ACTION, PERSON_ACTION, PROJECT_ACTION, REFRESH_ACTION, SUGGESTIONS_ACTION, TABS, publishHome } from "../home.ts";
import { SUGGESTIONS_BUTTON, readPayload, type SuggestionsButton } from "../payloads.ts";
import { loadTask } from "../tasks.ts";
import { changeTask } from "./changes.ts";
import type { Handler } from "../types.ts";

// The buttons on the Home tab (see home.ts): one for each view of the open
// tasks, the project picker, Refresh, which draws the view it's on again, and Assign to me, on
// the Unassigned view.
export default {
  actions: {
    // Home and Settings are the two parts of the tab; the tasks come back on the tab last used.
    [HOME_ACTION]: async (payload, { env }) => {
      await publishHome(env, payload.user.id);
    },
    [CONFIGURE_ACTION]: async (payload, { env }) => {
      await publishHome(env, payload.user.id, CONFIGURE);
    },
    // The person's own suggestions, off or on; Settings is drawn again to show it.
    [SUGGESTIONS_ACTION]: async (payload, { env }) => {
      const { on } = readPayload<SuggestionsButton>(SUGGESTIONS_BUTTON, payload.actions[0].value, "Suggestions button");
      await setSuggestions(env, payload.user.id, on);
      console.log("Suggestions turned", on ? "on" : "off", { user: payload.user.id });
      await publishHome(env, payload.user.id, CONFIGURE);
    },
    [REFRESH_ACTION]: async (payload, { env }) => {
      await publishHome(env, payload.user.id, payload.actions[0].value);
    },
    // The choice is kept for next time, and the tab drawn again, on the
    // view it was on (the view's private metadata).
    [PROJECT_ACTION]: async (payload, { env }) => {
      const { value } = payload.actions[0].selected_option;
      await setHomeProject(env, payload.user.id, value);
      await publishHome(env, payload.user.id, payload.view?.private_metadata);
    },
    // The team member picked on the By person view: the view is drawn again with their tasks. Whether
    // they are in the project's channel is checked when it is drawn.
    [PERSON_ACTION]: async (payload, { env }) => {
      const { value } = payload.actions[0].selected_option;
      await publishHome(env, payload.user.id, `person:${value}`);
    },
    // The button's id ends with the task's channel and thread. Someone may
    // have taken the task since the tab was drawn, and then it's left
    // alone. The card shows the new owner, so nothing is posted.
    [CLAIM_ACTION]: async (payload, { env }) => {
      const user = payload.user.id;
      const [channel, ts] = payload.actions[0].action_id.split(":").slice(2) as [string, string];
      const task = await loadTask(env, channel, ts);
      if (task && !Object.values(task.people).some((ids) => ids.length)) {
        await changeTask(env, { channel, ts }, { people: { owner: { add: [user] } } }, user);
      }
      await publishHome(env, user, "unassigned");
    },
    ...Object.fromEntries(
      Object.entries(TABS).map(([tab, { action }]) => [
        action,
        async (payload, { env }) => {
          await publishHome(env, payload.user.id, tab);
        },
      ]),
    ),
  },
} satisfies Handler;
