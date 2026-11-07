import { publishTask } from "./commands/track.ts";
import { unpostedTasks } from "./db.ts";
import { flushSummaries } from "./summary.ts";
import type { AppEnv } from "./env.ts";

// Summaries still out of date are rewritten too (see flushSummaries).
// Tasks are stored before they are posted. Any whose post Slack refused are
// posted again here, every few minutes (the cron in wrangler.toml), until
// POST_ATTEMPTS is reached.
export async function retryUnposted(env: AppEnv) {
  const tasks = await unpostedTasks(env);
  for (const record of tasks) await publishTask(env, record);
  if (tasks.length) console.log("Retried posts", { tasks: tasks.length });
  await flushSummaries(env);
}
