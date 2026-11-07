import { setProjectSetting } from "./db.ts";
import { callGoogle, googleEnabled } from "./google.ts";
import type { AppEnv } from "./env.ts";
import type { Project } from "./channels.ts";

// A block of a doc section, as writeSection takes them (see there).
export type DocBlock =
  | { type: "heading"; level: 2 | 3; text: string }
  | { type: "paragraph"; text: string; italic?: boolean }
  | { type: "item"; level: 0 | 1; parts: { text: string; link?: string }[] };

// A line of a section as it reads now (see readSection).
export interface DocElement {
  type: "heading" | "paragraph" | "item";
  level: number;
  text: string;
  links: string[];
}

// Each group's executive summaries are kept in its work doc (its `workDoc` in
// PROJECTS), which the team edits and goes through on calls: a section per
// summary in its Summary tab, newest first. After a call, get_executive_summary_doc
// reads the section back, for the agent to find what was added. They are written and read
// through the Google web app (see google.ts).
export const docsEnabled = googleEnabled;

// The tab summaries are written in, made if the doc has none.
export const SUMMARY_TAB = "Summary";

// Writes a section in the doc's Summary tab, making the tab if there is
// none: in place of the section with the same `key`, or at the top. A block
// is one of:
//   { type: "heading", level: 2 | 3, text }   level 2 starts the section
//   { type: "paragraph", text, italic? }
//   { type: "item", level: 0 | 1, parts: [{ text, link? }, …] }   a bullet
// Returns the tab's address.
export async function writeSection(env: AppEnv, docId: string, key: string, blocks: DocBlock[]): Promise<string> {
  const { url } = await callGoogle(env, { action: "doc.write", docId, tab: SUMMARY_TAB, key, blocks });
  return url;
}

// The section `key` as it now reads, as a list of { type: "heading" |
// "paragraph" | "item", level, text, links }, `links` being the addresses
// linked from it, or null if the section is gone.
export async function readSection(env: AppEnv, docId: string, key: string): Promise<DocElement[] | null> {
  const { elements } = await callGoogle(env, { action: "doc.read", docId, tab: SUMMARY_TAB, key });
  return elements ?? null;
}

// The ID of the group's work doc, where summaries go: its `workDoc`, or ""
// if it has none.
export function workDocId(group: Pick<Project, "workDoc"> | null | undefined) {
  return docId(group?.workDoc);
}

// Makes a project's work doc when the project is added (the Add project button), if it has none and
// Google is set up: a new doc called "<name> executive summaries" (viewable by link, editable by the
// account that owns the web app), kept in the database as the project's `workDoc`. Nothing else
// makes one. Returns "" when there is no doc and Google isn't set up; throws if it can't be made.
export async function ensureWorkDoc(env: AppEnv, project: Project, user: string | null = null) {
  const existing = workDocId(project);
  if (existing || !googleEnabled(env)) return existing;
  const { id } = await callGoogle(env, { action: "doc.create", title: `${project.name} executive summaries` });
  if (!docId(id)) throw new Error("Google didn't give a doc");
  await setProjectSetting(env, project.channel, "workDoc", id, user);
  project.workDoc = id;
  console.log("Work doc made", { project: project.name, channel: project.channel });
  return id;
}

// The doc's ID in its address (…/document/d/<id>/…), or `value` itself if it
// is an ID already, or "" if it is neither.
export function docId(value: string | null | undefined) {
  const match = /\/document\/d\/([\w-]{20,})/.exec(value ?? "") ?? /^([\w-]{20,})$/.exec(value ?? "");
  return match ? match[1] : "";
}
