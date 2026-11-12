// The terminal prompts of npm run setup and the other scripts, on @clack/prompts:
// text, hidden text, select, confirm and multi-select, all with the arrow
// keys, and Ctrl+C or Esc leaves cleanly.
import { spawn } from "node:child_process";
import * as clack from "@clack/prompts";

export { intro, log, note, outro, spinner } from "@clack/prompts";

// The answer, or leaves the program when the person cancelled.
function answered<T>(value: T | symbol): T {
  if (clack.isCancel(value)) {
    clack.cancel("Cancelled.");
    process.exit(130);
  }
  return value as T;
}

// An option to pick: what it shows, and what picking it gives.
type Option<T> = { label: string; value: T; hint?: string };

// A question as a clack message: no leading line break, no trailing colon or
// ellipsis, and no "[default]" (the default is shown as the placeholder).
function message(question: string) {
  return question.trim().replace(/\s*\[[^\]]*\]\s*:?$/, "").replace(/\s*[:…]+$/, "");
}

// Asks a question without showing what's typed, for tokens and secrets.
export async function askHidden(question: string): Promise<string> {
  return String(answered(await clack.password({ message: message(question), mask: "•" }))).trim();
}

// Asks for a line of text; Enter alone gives `fallback`.
export async function ask(question: string, fallback = ""): Promise<string> {
  const answer = answered(await clack.text({ message: message(question), placeholder: fallback || undefined, defaultValue: fallback }));
  return String(answer ?? "").trim() || fallback;
}

// Waits for Enter, for something the person has to do first.
export async function pause(question: string): Promise<void> {
  answered(await clack.text({ message: message(question), placeholder: "Press Enter to continue" }));
}

// Picks one of `options` ({ label, value, hint? }) with the arrow keys; returns its value.
export async function choose<T>(question: string, options: Option<T>[], { initial = 0 } = {}): Promise<T> {
  return answered<T>(await clack.select<T>({ message: message(question), options: options as never, initialValue: options[initial].value }));
}

// A Yes / No choice, as a boolean. `fallback` is the highlighted answer.
export function confirm(question: string, fallback = true): Promise<boolean> {
  return clack.confirm({ message: message(question), initialValue: fallback }).then((value) => answered<boolean>(value));
}

// Picks any number of `options` ({ label, value, hint? }), typing to search, Tab to tick; returns their values.
export async function chooseMany<T>(question: string, options: Option<T>[]): Promise<T[]> {
  return answered<T[]>(await clack.autocompleteMultiselect<T>({ message: message(question), options: options as never, required: false }));
}

// Opens a page in the person's browser (best effort; the address is always printed too).
export function openUrl(url: string) {
  const [command, ...args] = process.platform === "darwin" ? ["open"] : process.platform === "win32" ? ["cmd", "/c", "start", ""] : ["xdg-open"];
  try {
    spawn(command, [...args, url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {}
}
