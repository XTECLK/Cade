import { CLOSE_ALL, dismiss, mrkdwn, plainText } from "../slack.ts";
import { MAX_BLOCKED_REASON, PRIORITIES, ROLES, STATUSES, formatDueDate, loadTask, parsePullRequest, pickerDate } from "../tasks.ts";
import { applyChanges, prsAfter } from "./changes.ts";
import { statusOption } from "./status.ts";
import type { Handler } from "../types.ts";
import type { Changes, Context, Priority, Role, SlackPayload, Status, StoredTask } from "../types.ts";
import { EDIT_FORM, readPayload, type EditForm } from "../payloads.ts";

// Where a task is: its channel and its root message.
type Origin = { channel: string; ts: string };

const EDIT_VIEW = "task:edit";

// The checkbox for a task done in parts: Cade suggests no status changes for it, since a message
// about one part says nothing about the whole. Pull requests are still tracked.
const SUBTASKS_OPTION = {
  text: plainText("Has subtasks"),
  description: plainText("Cade won't suggest status changes from messages. Pull requests are still tracked."),
  value: "subtasks",
};

// The checkbox and reason for a blocked task: it keeps its status, and shows as blocked on its card.
const BLOCKED_OPTION = {
  text: plainText("Blocked"),
  description: plainText("Shown on the task's card until it is unblocked."),
  value: "blocked",
};

// The Edit form: everything on a task in one place, its owners,
// reviewers and testers, status, priority and due date, and pull requests.
// An incident's priority and due date never change, so its form leaves them
// out. The task card's ⋯ → Edit opens it as the task stands (see menu.ts),
// and a suggestion's Edit filled in with what was suggested (see
// ai-suggest.ts). Saving applies what changed as one change (see
// changes.ts), so the thread hears it as one message.

// The form for the task at `channel`/`ts`, with `changes` (as changes.ts
// takes them) already applied to what it shows. `responseUrl` is the private
// suggestion to remove once it's saved, and `told` who its message
// mentioned, so saving doesn't notify them again (see applyChanges).
export function editForm(
  { channel, ts }: Origin,
  task: StoredTask,
  { changes = {}, told, responseUrl }: { changes?: Changes; told?: string[]; responseUrl?: string } = {},
) {
  const details = !task.incident;
  const blockedNow = changes.blocked ? changes.blocked.on : task.blocked;
  const blockedReason = changes.blocked?.on ? changes.blocked.reason ?? "" : task.blocked && !changes.blocked ? task.blockedReason : "";
  const peopleAfter = (role: Role) => {
    const { add = [], remove = [] } = changes.people?.[role] ?? {};
    return [...task.people[role].filter((id) => !remove.includes(id)), ...add];
  };
  const priorityOption = (name: Priority) => ({ text: { ...plainText(`${PRIORITIES[name]} ${name}`), emoji: true }, value: name });
  const status = changes.status ?? task.status;
  const priority = changes.priority ?? task.priority;
  const dueDate = "dueDate" in changes ? changes.dueDate : task.dueDate;
  return {
    type: "modal",
    callback_id: EDIT_VIEW,
    private_metadata: JSON.stringify({ channel, ts, details, responseUrl, told }),
    title: plainText("Edit task"),
    submit: plainText("Save"),
    close: plainText("Cancel"),
    blocks: [
      ...(Object.keys(ROLES) as Role[]).map((role) => {
        const chosen = peopleAfter(role);
        return {
          type: "input",
          block_id: role,
          // Saving a role with no one clears it.
          optional: true,
          label: plainText(`${ROLES[role]}s`),
          element: {
            type: "multi_users_select",
            action_id: "value",
            placeholder: plainText(`Choose ${ROLES[role].toLowerCase()}s`),
            ...(chosen.length && { initial_users: chosen }),
          },
        };
      }),
      {
        type: "input",
        block_id: "status",
        label: plainText("Status"),
        element: {
          type: "static_select",
          action_id: "value",
          options: (Object.keys(STATUSES) as Status[]).map(statusOption),
          initial_option: statusOption(status),
        },
      },
      ...(details
        ? [
            // A subtask's priority is its task's (see followParent in tasks.ts), so its form leaves it out.
            ...(task.parent ? [] : [{
              type: "input",
              block_id: "priority",
              label: plainText("Priority"),
              element: {
                type: "static_select",
                action_id: "value",
                options: (Object.keys(PRIORITIES) as Priority[]).map(priorityOption),
                ...(PRIORITIES[priority] && { initial_option: priorityOption(priority) }),
              },
            }]),
            {
              type: "input",
              block_id: "due_date",
              // Saving with no date removes it.
              optional: true,
              label: plainText("Due date"),
              element: {
                type: "datepicker",
                action_id: "value",
                placeholder: plainText("Select a date"),
                ...(pickerDate(dueDate) && { initial_date: pickerDate(dueDate) }),
              },
            },
          ]
        : [{ type: "context", elements: [mrkdwn("Incidents are always :red_circle: Urgent and due Immediate.")] }]),
      {
        type: "input",
        block_id: "subtasks",
        optional: true,
        label: plainText("Subtasks"),
        element: {
          type: "checkboxes",
          action_id: "value",
          options: [SUBTASKS_OPTION],
          ...((changes.subtasks ?? task.subtasks) && { initial_options: [SUBTASKS_OPTION] }),
        },
      },
      {
        type: "input",
        block_id: "blocked",
        optional: true,
        label: plainText("Blocked"),
        element: {
          type: "checkboxes",
          action_id: "value",
          options: [BLOCKED_OPTION],
          ...(blockedNow && { initial_options: [BLOCKED_OPTION] }),
        },
      },
      {
        type: "input",
        block_id: "blocked_reason",
        optional: true,
        label: plainText("Why it is blocked"),
        element: {
          type: "plain_text_input",
          action_id: "value",
          max_length: MAX_BLOCKED_REASON,
          ...(blockedReason && { initial_value: blockedReason }),
        },
      },
      {
        type: "input",
        block_id: "prs",
        // Saving with none unlinks them all.
        optional: true,
        label: plainText("Pull requests, one link per line"),
        element: {
          type: "plain_text_input",
          action_id: "value",
          multiline: true,
          placeholder: plainText("https://github.com/acme/web/pull/12"),
          initial_value: prsAfter(task, changes).join("\n") || undefined,
        },
      },
    ],
  };
}

// Saves the form as the changes from the task as it is now, having removed
// the private suggestion it came from, if any.
function saveEdit(payload: SlackPayload, context: Context) {
  const { channel, ts, details, responseUrl, told } = readPayload<EditForm>(EDIT_FORM, payload.view.private_metadata, "Edit form");
  const { values } = payload.view.state;
  const lines = (values.prs?.value.value ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  const urls = lines.map((line) => parsePullRequest(line.replace(/^<|[|>].*$/g, ""))?.url);
  const wrong = lines.find((line, i) => !urls[i]);
  if (wrong) {
    return { response_action: "errors", errors: { prs: `That doesn't look like a pull request link: ${wrong}`.slice(0, 150) } };
  }
  context.waitUntil(
    (async () => {
      const { env } = context;
      await dismiss(responseUrl);
      const task = await loadTask(env, channel, ts);
      if (!task) return;
      const changes: Changes & { people: NonNullable<Changes["people"]> } = { people: {} };
      for (const role of Object.keys(ROLES) as Role[]) {
        const chosen = values[role]?.value.selected_users ?? [];
        changes.people[role] = {
          add: chosen.filter((id) => !task.people[role].includes(id)),
          remove: task.people[role].filter((id) => !chosen.includes(id)),
        };
      }
      const status = values.status!.value.selected_option!.value as Status;
      if (status !== task.status) changes.status = status;
      if (details) {
        changes.priority = (values.priority?.value.selected_option?.value ?? task.priority) as Priority;
        changes.dueDate = formatDueDate(values.due_date!.value.selected_date);
      }
      changes.subtasks = (values.subtasks?.value.selected_options ?? []).length > 0;
      changes.blocked = (values.blocked?.value.selected_options ?? []).length > 0
        ? { on: true, reason: values.blocked_reason?.value.value ?? "" }
        : { on: false };
      const wanted = [...new Set(urls)] as string[];
      changes.prs = { add: wanted.filter((url) => !task.prs.includes(url)), remove: task.prs.filter((url) => !wanted.includes(url)) };
      await applyChanges(env, { channel, ts }, changes, payload.user.id, { told });
    })(),
  );
  return CLOSE_ALL;
}

export default {
  views: { [EDIT_VIEW]: saveEdit },
} satisfies Handler;
