import { CLOSE_ALL, mrkdwn, plainText, respondLater } from "../slack.ts";
import { loadTask, openPrs, parsePullRequest, prLink, prState } from "../tasks.ts";
import { applyChanges } from "./changes.ts";
import type { Handler } from "../types.ts";
import type { Context, PrState, SlackPayload, StoredTask } from "../types.ts";
import { TASK_BUTTON, readPayload, type TaskRef } from "../payloads.ts";

const PRS_VIEW = "task:prs";

// What the buttons of a partial release say now that there are none: requests for approval posted
// before they went still have them in their threads.
const NO_RELEASES = "Partial releases are gone. To ask for approval, move the task to Client review, or ask in its thread.";
const OLD_RELEASE_ACTIONS = ["release:open", "release:approve", "release:reject"];

// The Pull requests form, from the task card's Pull requests button (see menu.ts): the task's pull
// requests by where they stand on GitHub (see github.ts). Those open are in a box, one link a line,
// to add to and take from, as the Edit form had them; merged and closed ones are listed under it, to
// see, and stay linked. Saving links and unlinks what changed, and the thread hears it as any change.
export function prsForm({ channel, ts }: TaskRef, task: StoredTask) {
  const listed = (state: PrState, label: string) => {
    const prs = task.prs.filter((url) => prState(task, url) === state);
    return prs.length ? [{ type: "section", text: mrkdwn(`*${label}*\n${prs.map(prLink).join("\n")}`) }] : [];
  };
  const open = openPrs(task);
  return {
    type: "modal",
    callback_id: PRS_VIEW,
    private_metadata: JSON.stringify({ channel, ts }),
    title: plainText("Pull requests"),
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
      ...listed("MERGED", "Merged"),
      ...listed("CLOSED", "Closed"),
    ],
  };
}

// Saves the form: links the new links, and unlinks the open ones taken out. A merged or closed one
// stays, written in the box or not.
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

export default {
  views: { [PRS_VIEW]: savePrs },
  actions: Object.fromEntries(OLD_RELEASE_ACTIONS.map((action) => [action, noReleases])),
} satisfies Handler;
