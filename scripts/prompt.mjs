// The terminal prompts of npm run setup, group and dev, on @clack/prompts:
// text, hidden text, select, confirm and multi-select, all with the arrow
// keys, and Ctrl+C or Esc leaves cleanly.
import * as clack from "@clack/prompts";

export { intro, log, note, outro, spinner } from "@clack/prompts";

// The answer, or leaves the program when the person cancelled.
function answered(value) {
  if (clack.isCancel(value)) {
    clack.cancel("Cancelled.");
    process.exit(130);
  }
  return value;
}

// A question as a clack message: no leading line break, no trailing colon or
// ellipsis, and no "[default]" (the default is shown as the placeholder).
function message(question) {
  return question.trim().replace(/\s*\[[^\]]*\]\s*:?$/, "").replace(/\s*[:…]+$/, "");
}

// Asks a question without showing what's typed, for tokens and secrets.
export async function askHidden(question) {
  return String(answered(await clack.password({ message: message(question), mask: "•" }))).trim();
}

// Asks for a line of text; Enter alone gives `fallback`.
export async function ask(question, fallback = "") {
  const answer = answered(await clack.text({ message: message(question), placeholder: fallback || undefined, defaultValue: fallback }));
  return String(answer ?? "").trim() || fallback;
}

// Waits for Enter, for something the person has to do first.
export async function pause(question) {
  answered(await clack.text({ message: message(question), placeholder: "Press Enter to continue" }));
}

// Picks one of `options` ({ label, value, hint? }) with the arrow keys; returns its value.
export async function choose(question, options, { initial = 0 } = {}) {
  return answered(await clack.select({ message: message(question), options, initialValue: options[initial].value }));
}

// A Yes / No choice, as a boolean. `fallback` is the highlighted answer.
export function confirm(question, fallback = true) {
  return clack.confirm({ message: message(question), initialValue: fallback }).then(answered);
}

// Picks any number of `options` ({ label, value, hint? }), typing to search, Tab to tick; returns their values.
export async function chooseMany(question, options) {
  return answered(await clack.autocompleteMultiselect({ message: message(question), options, required: false }));
}
