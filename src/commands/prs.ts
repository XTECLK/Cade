import { CLOSE_ALL, callSlack, mrkdwn, plainText, respondLater } from "../slack.ts";
import { loadTask, openPrs, parsePullRequest, prState } from "../tasks.ts";
import { applyChanges } from "./changes.ts";
import type { Handler } from "../types.ts";
import type { AppEnv } from "../env.ts";
import type { Context, PrState, SlackPayload, StoredTask } from "../types.ts";
import { TASK_BUTTON, readPayload, type TaskRef } from "../payloads.ts";

const PRS_VIEW = "task:prs";
// Edit, on the Open section of the list.
const PRS_EDIT_ACTION = "prs:edit";

// What the buttons of a partial release say now that there are none: requests for approval posted
// before they went still have them in their threads.
const NO_RELEASES = "Partial releases are gone. To ask for approval, move the task to Client review, or ask in its thread.";
const OLD_RELEASE_ACTIONS = ["release:open", "release:approve", "release:reject"];

// The Pull requests list, from the task card's Pull requests button (see menu.ts): the task's pull
// requests by where they stand on GitHub (see github.ts), Open, Merged and Closed, each as its full
// link, to see. Only Open has Edit, which opens the form for them on top (see prsForm): merged and
// closed ones stay linked.
export function prsView({ channel, ts }: TaskRef, task: StoredTask) {
  const section = (state: PrState, label: string) => {
    const prs = task.prs.filter((url) => prState(task, url) === state);
    const list = prs.length ? prs.map((url) => `<${url}>`).join("\n") : "_None_";
    const edit = state === "OPEN" && {
      accessory: { type: "button", action_id: PRS_EDIT_ACTION, text: plainText("Edit"), value: JSON.stringify({ channel, ts }) },
    };
    return { type: "section", text: mrkdwn(`*${label}*\n${list}`), ...edit };
  };
  return {
    type: "modal",
    title: plainText("Pull requests"),
    close: plainText("Close"),
    blocks: [section("OPEN", "Open"), { type: "divider" }, section("MERGED", "Merged"), { type: "divider" }, section("CLOSED", "Closed")],
  };
}

// The form for the task's open pull requests, from Edit on the list: in a box, one link a line, to add
// to and take from. Saving links and unlinks what changed, and the thread hears it as any change.
export function prsForm({ channel, ts }: TaskRef, task: StoredTask) {
  const open = openPrs(task);
  return {
    type: "modal",
    callback_id: PRS_VIEW,
    private_metadata: JSON.stringify({ channel, ts }),
    title: plainText("Open pull requests"),
    submit: plainText("Save"),
    close: plainText("Cancel"),
    blocks: [
      {
        type: "input",
        block_id: "prs",
        // Saving with none unlinks the open ones.
        optional: true,
        label: plainText("Open, one link per line"),
        hint: plainText("Add a link to link it, or delete one to unlink it."),
        element: {
          type: "plain_text_input",
          action_id: "value",
          multiline: true,
          placeholder: plainText("https://github.com/acme/web/pull/12"),
          ...(open.length && { initial_value: open.join("\n") }),
        },
      },
    ],
  };
}

// Saves the form: links the new links, and unlinks the open ones taken out. A merged or closed one
// stays, written in the box or not. Both the form and the list under it close.
function savePrs(payload: SlackPayload, context: Context) {
  const { channel, ts } = readPayload<TaskRef>(TASK_BUTTON, payload.view.private_metadata, "Pull requests form");
  const lines = (payload.view.state.values.prs?.value.value ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  const urls = lines.map((line) => parsePullRequest(line.replace(/^<|[|>].*$/g, ""))?.url);
  const wrong = lines.find((line, i) => !urls[i]);
  if (wrong) {
    return { response_action: "errors", errors: { prs: `That doesn't look like a pull request link: ${wrong}`.slice(0, 150) } };
  }
  context.waitUntil(
    (async () => {
      const task = await loadTask(context.env, channel, ts);
      if (!task) return;
      const wanted = [...new Set(urls)] as string[];
      const prs = { add: wanted.filter((url) => !task.prs.includes(url)), remove: openPrs(task).filter((url) => !wanted.includes(url)) };
      await applyChanges(context.env, { channel, ts }, { prs }, payload.user.id);
    })(),
  );
  return CLOSE_ALL;
}

// Says, only to whoever clicked it, that a partial release's button no longer does anything.
async function noReleases(payload: SlackPayload) {
  await respondLater(payload.response_url, { replace_original: false, text: NO_RELEASES });
}

// Edit on the list's Open section: the form, on top of the list, for the task as it is now.
async function openPrsForm(payload: SlackPayload, env: AppEnv) {
  const { channel, ts } = readPayload<TaskRef>(TASK_BUTTON, payload.actions[0].value, "Pull requests' Edit button");
  const task = await loadTask(env, channel, ts);
  if (!task) return;
  await callSlack(env, "views.push", { trigger_id: payload.trigger_id, view: prsForm({ channel, ts }, task) });
}

export default {
  views: { [PRS_VIEW]: savePrs },
  actions: {
    [PRS_EDIT_ACTION]: (payload, { env }) => openPrsForm(payload, env),
    ...Object.fromEntries(OLD_RELEASE_ACTIONS.map((action) => [action, noReleases])),
  },
} satisfies Handler;
