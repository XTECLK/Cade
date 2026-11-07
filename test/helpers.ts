// What the tests share.

// The ExecutionContext the Worker is given in a test: waitUntil, which is all Cade uses of it, with
// what to do with the work handed to it (nothing, by default).
export const context = (waitUntil: (promise: Promise<unknown>) => void = () => {}) =>
  ({ waitUntil, passThroughOnException() {} }) as unknown as ExecutionContext;

// A stand-in for a `T` with only what the code under test reads of it, such as a task with just its
// status and people, or an env with just its AI binding: for unit tests of one function.
export const fake = <T>(value: unknown) => value as T;
