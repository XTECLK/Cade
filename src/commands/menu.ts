import { callSlack } from "../slack.ts";
import { NOT_A_TASK, TASK_EDIT_ACTION, TASK_MENU_ACTION, TASK_PRS_ACTION, TASK_SUBTASKS_ACTION, loadTask } from "../tasks.ts";
import { editForm } from "./edit.ts";
import { archiveTask } from "./archive.ts";
import { prsView } from "./prs.ts";
import { subtaskForm, subtasksView } from "./subtask.ts";
import type { Context, Handler, SlackPayload } from "../types.ts";
import type { AppEnv } from "../env.ts";
import type { StoredTask } from "../types.ts";

type Origin = { channel: string; ts: string };

// The buttons and the ⋯ menu on a task's card (see taskActions in tasks.ts), without a command
// message in the task's thread:
//   Edit     (the button) one form for the people, status, priority and due date (not on
//            an incident, whose are fixed) (see edit.ts);
//            saving it posts who changed what in the thread, as the record,
//            and the card updates.
//   Subtasks (the button) on a task that isn't a subtask: them, in a modal, each linking to its
//            thread, with Add subtask, which opens the form for one (see subtask.ts).
//   Pull requests (the button) the task's pull requests, Open, Merged and Closed, with Edit on the
//            open ones (see prs.ts).
//   Archive  archives the task, as `@Cade archive` does (see archive.ts),
//            telling its thread who did.
// Anything Cade can't do is said only to whoever chose it. Cards posted before had Edit, Add subtask
// and View subtasks in the menu, which still open them, and other choices (Release, before partial
// releases went), which open Edit.
const FORMS: Record<"edit" | "subtask" | "subtasks" | "prs", (env: AppEnv, origin: Origin, task: StoredTask) => unknown> = {
  edit: (env, origin, task) => editForm(origin, task),
  subtask: (env, origin, task) => subtaskForm(origin, task),
  subtasks: (env, origin, task) => subtasksView(env, origin, task),
  prs: (env, origin, task) => prsView(origin, task),
};

export default {
  actions: {
    // Opening a form must happen within Slack's three seconds of the click.
    // The buttons are on the task's root message.
    [TASK_EDIT_ACTION]: (payload, context) => openForm(payload, context, "edit"),
    [TASK_SUBTASKS_ACTION]: (payload, context) => openForm(payload, context, "subtasks"),
    [TASK_PRS_ACTION]: (payload, context) => openForm(payload, context, "prs"),
    [TASK_MENU_ACTION]: (payload, context) => openForm(payload, context, payload.actions[0].selected_option.value),
  },
} satisfies Handler;

// Does what `choice` on the card of the task the payload came from asks: archives it, or opens its form.
async function openForm(payload: SlackPayload, context: Context, choice: string) {
  const { env } = context;
  const origin = { channel: payload.channel.id, ts: payload.message.ts };
  const task = await loadTask(env, origin.channel, origin.ts);
  if (choice === "archive" && task) {
    context.waitUntil(
      (async () => {
        const text = await archiveTask(env, origin.channel, origin.ts, payload.user.id);
        if (text) await callSlack(env, "chat.postMessage", { channel: origin.channel, thread_ts: origin.ts, text });
      })(),
    );
    return;
  }
  const form = FORMS[choice as keyof typeof FORMS] ?? FORMS.edit;
  const view = task ? await form(env, origin, task) : NOT_A_TASK;
  if (typeof view === "string") {
    await callSlack(env, "chat.postEphemeral", { channel: origin.channel, user: payload.user.id, text: view });
    return;
  }
  await callSlack(env, "views.open", { trigger_id: payload.trigger_id, view });
}
