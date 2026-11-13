// Where tasks' pull requests stand on GitHub: open, merged or closed, which the task card counts and
// the Pull requests form groups them by (see prs.ts). The cron reads them every PR_SYNC_MINUTES, with
// the deployment's GITHUB_TOKEN, a token that can read the repositories' pull requests; without one,
// nothing is read and every pull request counts as open. Only GitHub's are read: GitLab's and
// Bitbucket's count as open.
//
// One GraphQL request a run asks for up to PER_RUN pull requests of open tasks, never read ones first
// (see prsToSync), so a new link is read at the next run. A merged one is never asked again. Cards whose
// pull requests changed are redrawn. `/cade resync` reads its tasks' too, all in one request.
//
// A pull request is also read as it is linked (see knowPrStates), so the card, and who is asked to
// review, have where it stands from the start, and a change the sync finds later is a real one.
// One GitHub doesn't tell in time (or can't see, or without GITHUB_TOKEN) is saved as open, which the
// card showed it as, so finding it merged later is told too.
//
// Every change to a task is told in its thread, and so is an open pull request being merged or closed,
// whichever reads it: one message for each task, with all of its pull requests that ended in the read
// (see announceEnded). One never saved before isn't: it was linked merged or closed, and the thread
// heard it linked.
import { addOpenPrs, prStatesOf, prsToSync, setPrStates, tasksWithPrs } from "./db.ts";
import { prsEnded } from "./notify.ts";
import { callSlack } from "./slack.ts";
import { taskMessage } from "./tasks.ts";
import type { AppEnv } from "./env.ts";
import type { PrChange, PrState } from "./types.ts";

export const PR_SYNC_MINUTES = 15;
const PER_RUN = 50;
// How long linking waits for GitHub: someone is waiting on it. Past that the link is saved anyway,
// and the sync reads it first.
const LINK_TIMEOUT_MS = 2000;

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
  const changed = await readPrStates(env, await prsToSync(env, PER_RUN));
  if (!changed.length) return;
  for (const { channel, ts, task } of await tasksWithPrs(env, changed)) {
    await callSlack(env, "chat.update", { channel, ts, ...taskMessage(task) }).catch((error: Error) => {
      console.warn("Could not redraw a card after its pull requests changed", { ts, error: error.message });
    });
  }
}

// Where pull requests about to be linked stand, `urls`, as { url: state }, for the task to be saved
// with: read from GitHub, and those it didn't tell (without GITHUB_TOKEN, failing, too slow, one it
// can't see, another host's) saved as open, unless saved before, marked for the sync to read next.
export async function knowPrStates(env: AppEnv, urls: string[]) {
  if (!urls.length) return {};
  await readPrStates(env, urls, { timeoutMs: LINK_TIMEOUT_MS });
  await addOpenPrs(env, urls);
  return prStatesOf(env, urls);
}

// Reads where the GitHub ones of `urls` stand, in one request, saves it, and tells the threads of the
// tasks whose open ones were merged or closed; returns those whose state changed. Also for `/cade
// resync` (see resync.ts), which redraws the cards itself, and for linking (see knowPrStates), which
// gives up after `timeoutMs`. Nothing without GITHUB_TOKEN, or when GitHub can't be reached: they keep
// the state last saved.
export async function readPrStates(env: AppEnv, urls: string[], { timeoutMs }: { timeoutMs?: number } = {}) {
  if (!env.GITHUB_TOKEN) return [];
  const prs = [...new Set(urls)].flatMap((url) => {
    const match = GITHUB_PR.exec(url);
    return match ? [{ url, owner: match[1]!, repo: match[2]!, number: Number(match[3]) }] : [];
  });
  if (!prs.length) return [];
  const query = `query { ${prs
    .map(({ owner, repo, number }, i) => `p${i}: repository(owner: "${owner}", name: "${repo}") { pullRequest(number: ${number}) { state } }`)
    .join(" ")} }`;
  let answer: GitHubAnswer;
  try {
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { authorization: `bearer ${env.GITHUB_TOKEN}`, "content-type": "application/json", "user-agent": "Cade" },
      body: JSON.stringify({ query }),
      ...(timeoutMs && { signal: AbortSignal.timeout(timeoutMs) }),
    });
    if (!response.ok) {
      console.warn("GitHub refused the pull request query", { status: response.status });
      return [];
    }
    answer = await response.json<GitHubAnswer>();
  } catch (error) {
    console.warn("Could not reach GitHub for pull requests", { error: error.message });
    return [];
  }
  if (answer.errors?.length) console.warn("GitHub couldn't read some pull requests", { errors: answer.errors.length, first: answer.errors[0]!.message });
  const states = prs.flatMap(({ url }, i) => {
    const state = STATES.find((known) => known === answer.data?.[`p${i}`]?.pullRequest?.state);
    return state ? [{ url, state }] : [];
  });
  const changed = await setPrStates(env, states);
  console.log("Pull requests read from GitHub", { asked: prs.length, read: states.length, changed: changed.length });
  await announceEnded(env, changed);
  return changed.map(({ url }) => url);
}

// Tells each task linking pull requests that were open and are now merged or closed, in its thread, in
// one message. A thread that can't be told is left: the card still counts them.
async function announceEnded(env: AppEnv, changed: PrChange[]) {
  const ended = new Map(changed.filter(({ from, to }) => from === "OPEN" && to !== "OPEN").map(({ url, to }) => [url, to]));
  if (!ended.size) return;
  for (const { channel, ts, task } of await tasksWithPrs(env, [...ended.keys()])) {
    const theirs = task.prs.filter((url) => ended.has(url));
    const text = prsEnded(
      theirs.filter((url) => ended.get(url) === "MERGED"),
      theirs.filter((url) => ended.get(url) === "CLOSED"),
    ).join("\n");
    await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, text }).catch((error: Error) => {
      console.warn("Could not tell a thread its pull requests were merged or closed", { ts, error: error.message });
    });
  }
}
