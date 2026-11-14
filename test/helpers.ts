// What the tests share.

// The ExecutionContext the Worker is given in a test: waitUntil, which is all Cade uses of it, with
// what to do with the work handed to it (nothing, by default).
export const context = (waitUntil: (promise: Promise<unknown>) => void = () => {}) =>
  ({ waitUntil, passThroughOnException() {} }) as unknown as ExecutionContext;

// A stand-in for a `T` with only what the code under test reads of it, such as a task with just its
// status and people, or an env with just its AI binding: for unit tests of one function.
export const fake = <T>(value: unknown) => value as T;

// A prompt as a deployment writes one, naming tools and fields as the template's examples do.
export const EXAMPLE = `---
description: Write a Cade task's summary from its Slack threads, and save it.
arguments:
  task: The task: its ID, a link to its card, or its title.
---

# Summarize a task

1. \`get_task_summary\` with the \`task_id\`, then \`get_thread_history\` with each \`moved_from.thread_id\`.
2. Show the summary, then \`save_task_summary\` with \`task_id\`, \`summary\` and \`through\`.
`;
