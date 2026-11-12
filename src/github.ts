// Where tasks' pull requests stand on GitHub: open, merged or closed, which the task card counts and
// the Pull requests form groups them by (see prs.ts). The cron reads them every PR_SYNC_MINUTES, with
// the deployment's GITHUB_TOKEN, a token that can read the repositories' pull requests; without one,
// nothing is read and every pull request counts as open. Only GitHub's are read: GitLab's and
// Bitbucket's count as open.
//
// One GraphQL request a run asks for up to PER_RUN pull requests of open tasks, never read ones first
// (see prsToSync), so a new link is read at the next run. A merged one is never asked again. Cards whose
// pull requests changed are redrawn.
import { prsToSync, setPrStates, tasksWithPrs } from "./db.ts";
import { callSlack } from "./slack.ts";
import { taskMessage } from "./tasks.ts";
import type { AppEnv } from "./env.ts";
import type { PrState } from "./types.ts";

export const PR_SYNC_MINUTES = 15;
const PER_RUN = 50;

// A GitHub pull request's address: its owner, repository and number.
const GITHUB_PR = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)$/;

const STATES: PrState[] = ["OPEN", "MERGED", "CLOSED"];

// What Cade reads of GitHub's answer: each pull request asked for, by its alias, or null where it
// can't be read (gone, or not one the token can see), with the errors saying why.
type GitHubAnswer = {
  data?: Record<string, { pullRequest: { state: string } | null } | null> | null;
  errors?: { message: string }[];
};

// Reads where the pull requests of open tasks stand, saves it, and redraws the cards of the tasks
// whose pull requests changed.
export async function syncPullRequests(env: AppEnv) {
  if (!env.GITHUB_TOKEN) return;
  const prs = (await prsToSync(env, PER_RUN)).flatMap((url) => {
    const match = GITHUB_PR.exec(url);
    return match ? [{ url, owner: match[1]!, repo: match[2]!, number: Number(match[3]) }] : [];
  });
  if (!prs.length) return;
  const query = `query { ${prs
    .map(({ owner, repo, number }, i) => `p${i}: repository(owner: "${owner}", name: "${repo}") { pullRequest(number: ${number}) { state } }`)
    .join(" ")} }`;
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `bearer ${env.GITHUB_TOKEN}`, "content-type": "application/json", "user-agent": "Cade" },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) {
    console.warn("GitHub refused the pull request query", { status: response.status });
    return;
  }
  const answer = await response.json<GitHubAnswer>();
  if (answer.errors?.length) console.warn("GitHub couldn't read some pull requests", { errors: answer.errors.length, first: answer.errors[0]!.message });
  const states = prs.flatMap(({ url }, i) => {
    const state = STATES.find((known) => known === answer.data?.[`p${i}`]?.pullRequest?.state);
    return state ? [{ url, state }] : [];
  });
  const changed = await setPrStates(env, states);
  console.log("Pull requests read from GitHub", { asked: prs.length, read: states.length, changed: changed.length });
  if (!changed.length) return;
  for (const { channel, ts, task } of await tasksWithPrs(env, changed)) {
    await callSlack(env, "chat.update", { channel, ts, ...taskMessage(task) }).catch((error: Error) => {
      console.warn("Could not redraw a card after its pull requests changed", { ts, error: error.message });
    });
  }
}
