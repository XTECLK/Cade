// What the tests share.

// The Slack signing secret the tests' Workers have, and the headers Slack signs a request `body` with at
// `timestamp` (now, unless a test is about an old one).
export const SIGNING_SECRET = "test-signing-secret";
export async function sign(body: string, timestamp = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`));
  const hex = [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { "x-slack-request-timestamp": String(timestamp), "x-slack-signature": `v0=${hex}` };
}

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

1. \`get_task_summary\` with the \`task_id\`, then \`get_task_history\` with \`since\` its \`through\`.
2. Show the summary, then \`save_task_summary\` with \`task_id\`, \`summary\` and \`through\`.
`;
