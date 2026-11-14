// What Cade is and what an agent can do with it: the `description` of serverInfo in MCP's initialize,
// for a client to show. It is a summary, not a rule, so it is not part of the guardrails (see
// guardrails.ts). Edit it here: each entry is one sentence, and they are joined with a space.

export const ABOUT = [
  `Cade is a project management and task tracking tool that lives in Slack.`,
  `A team turns Slack conversations into tasks and incidents, assigns people, and follows them through statuses to Done.`,
  `A task belongs to a project (a pair of Slack channels) and has a title, status, priority, due date, people (owner, reviewer and tester), pull requests, and a summary that people's agents keep.`,
  `Through this server a person's own AI agent can create tasks, create incidents and summarize a task.`,
  `It can also read tasks and threads, change a task, post in a task's thread or any other, and see who has room for more work.`,
  `These tools are building blocks: any other agent or tool can use them to implement a team's own workflows, such as generating an executive summary, which Cade doesn't do itself.`,
  `Some workflows come as prompts a person can pick, such as summarizing a task or writing an executive summary.`,
];

// What the client is sent.
export const SERVER_DESCRIPTION = ABOUT.join(" ");

// The version of the server, for a client to show (serverInfo.version). The version of the tool set,
// which changes with any change to the tools, their descriptions, the instructions or this summary,
// is worked out from them in mcp.ts, so it can't be forgotten.
export const SERVER_VERSION = "1.0.0";
