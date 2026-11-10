import { markTaskArchived } from "../db.ts";
import { callSlack } from "../slack.ts";
import { NOT_A_TASK, loadTask, redrawParent, refreshSummary, taskMessage } from "../tasks.ts";
import type { Handler } from "../types.ts";
import type { AppEnv } from "../env.ts";

// `@Cade archive` in a task's thread, or Archive on its card's ⋯ menu,
// puts away a task that's no longer needed. Cade stops tracking it, so it
// leaves standups and briefs, and commands in its
// thread no longer find it; but nothing is deleted, and the summary lists
// it under Archived. Its card stays, saying who archived it, with
// no menu; its thread stays and hears who archived it.
// `/cade remove <link>` can still delete it.
export default {
  name: "archive",
  description: "Archive the task: Cade stops tracking it, and its thread stays (in its thread)",
  usage: "@Cade archive",
  section: "task",
  channel: "channel",
  inThread: true,
  async run(command, { env }) {
    return (await archiveTask(env, command.channel, command.threadTs!, command.user)) ?? NOT_A_TASK;
  },
} satisfies Handler;

// Archives the task at `channel`/`ts` for `user`, and returns what its
// thread hears, or null if it isn't a task Cade is tracking.
export async function archiveTask(env: AppEnv, channel: string, ts: string, user: string) {
  const task = await loadTask(env, channel, ts);
  if (!task) return null;
  await markTaskArchived(env, channel, ts, user);
  await callSlack(env, "chat.update", { channel, ts, ...taskMessage(task, { archivedBy: user }) });
  await redrawParent(env, channel, task);
  await refreshSummary(env, channel);
  console.log("Task archived", { ts, user });
  return `<@${user}> archived this task.`;
}
