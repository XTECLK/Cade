// The workspace's people for the MCP tools: get_user, get_users, find_user_by_name, get_availability and
// get_team_availability.
import { channelMembers } from "../access.ts";
import { OPEN, todayIn } from "../commands/tasks.ts";
import { tasksWithStatuses } from "../db.ts";
import { AVAILABILITY_FIELDS, DEFAULT_USERS, MAX_MATCHES, MAX_PRESENCE, MAX_USERS, USER_FIELDS } from "../mcp-tools.ts";
import { callSlack, type SlackUser } from "../slack.ts";
import { ROLES } from "../tasks.ts";
import type {
  FindUserByNameArgs,
  GetAvailabilityArgs,
  GetTeamAvailabilityArgs,
  GetUserArgs,
  GetUsersArgs,
} from "../mcp-args.ts";
import type { AppEnv } from "../env.ts";
import type { Role } from "../types.ts";
import { ToolError, PAGE, MAX_PAGES, readableProject } from "./common.ts";

export async function resolveUserName(env: AppEnv, user: string, { user_id: id, profile: withProfile }: GetUserArgs) {
  const match = /\b[UW][A-Z0-9]{2,}\b/.exec(String(id ?? ""));
  if (!match) throw new ToolError("That isn't a Slack user ID. They look like U0123ABCD.");
  try {
    const { user: found } = await callSlack(env, "users.info", { user: match[0] });
    const name = found.real_name || found.profile?.real_name || found.profile?.display_name || found.name || match[0];
    const handle = found.profile?.display_name;
    const shown = handle && handle !== name ? `${name} (${handle})` : name;
    const data: {
      user_id: string;
      name: string;
      handle: string;
      profile: { email: string; phone: string; title: string } | null;
    } = { user_id: match[0], name, handle: handle && handle !== name ? handle : "", profile: null };
    if (!withProfile) return { text: shown, data };
    data.profile = {
      email: found.profile?.email ?? "",
      phone: found.profile?.phone ?? "",
      title: found.profile?.title ?? "",
    };
    const lines = [
      shown,
      `Email: ${data.profile.email || "(none)"}`,
      `Phone: ${data.profile.phone || "(none)"}`,
      `Title: ${data.profile.title || "(none)"}`,
    ];
    return { text: lines.join("\n"), data };
  } catch (error) {
    throw new ToolError(`I couldn't look up ${match[0]} (${error.message}).`);
  }
}

// The people of the workspace, up to `max` of those `keep(names)` accepts, as
// { line, total }: a "Name (handle): ID" line each, and how many there were in
// all (not counted past the pages read). Bots and deactivated accounts are left out.
async function workspacePeople(
  env: AppEnv,
  keep: (names: string[]) => boolean,
  max: number,
  fields: string[] | undefined,
) {
  const lines: string[] = [];
  const users: Record<string, unknown>[] = [];
  let total = 0;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await callSlack(env, "users.list", { limit: PAGE, ...(cursor && { cursor }) }).catch((error) => {
      throw new ToolError(`I couldn't list the workspace's people (${error.message}).`);
    });
    for (const member of result.members ?? []) {
      if (member.deleted || member.is_bot || member.id === "USLACKBOT") continue;
      const names = [member.real_name, member.profile?.real_name, member.profile?.display_name, member.name].filter(
        (name): name is string => Boolean(name),
      );
      if (!keep(names)) continue;
      total++;
      if (lines.length < max) {
        const person: Record<string, string | undefined> = {
          user_id: member.id,
          name: names[0],
          username: member.name ?? names.at(-1),
        };
        const shown = fields ?? USER_FIELDS;
        const label =
          shown.includes("name") && shown.includes("username")
            ? `${person.name} (${person.username}): `
            : shown.length
              ? `${person[shown[0]!]}: `
              : "";
        lines.push(`${label}${member.id}`);
        users.push(fields ? Object.fromEntries(["user_id", ...fields].map((field) => [field, person[field]])) : person);
      }
    }
    cursor = result.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return { lines, users, total };
}

// A ToolError unless `fields` is undefined or a list of USER_FIELDS.
function checkUserFields(fields: unknown) {
  if (fields !== undefined && !(Array.isArray(fields) && fields.every((field) => USER_FIELDS.includes(field))))
    throw new ToolError(`fields is a list of: ${USER_FIELDS.join(", ")}.`);
}

// Slack users whose name matches, to give a user ID to assign.
export async function findUser(env: AppEnv, user: string, { name, fields }: FindUserByNameArgs) {
  checkUserFields(fields);
  const wanted = String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@/, "");
  if (wanted.length < 2) throw new ToolError("Give at least two letters of the person's name.");
  const { lines, users, total } = await workspacePeople(
    env,
    (names) => names.some((candidate) => candidate.toLowerCase().includes(wanted)),
    MAX_MATCHES,
    fields,
  );
  if (!total) return { text: `No one in the workspace matches "${name}".`, data: { total: 0, users: [] } };
  return {
    text: [
      `${total} match${total === 1 ? "" : "es"}${total > lines.length ? `, showing ${lines.length}` : ""}:`,
      ...lines,
    ].join("\n"),
    data: { total, users },
  };
}

// The people of the workspace, by name, with their user IDs.
export async function getUsers(env: AppEnv, user: string, { limit, fields }: GetUsersArgs) {
  checkUserFields(fields);
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= MAX_USERS))
    throw new ToolError(`limit is a whole number from 1 to ${MAX_USERS}.`);
  const { lines, users, total } = await workspacePeople(env, () => true, limit ?? DEFAULT_USERS, fields);
  if (!total) return { text: "No one is in the workspace.", data: { total: 0, users: [] } };
  return {
    text: [
      `${total} ${total === 1 ? "person" : "people"}${total > lines.length ? `, showing the first ${lines.length}; raise limit (up to ${MAX_USERS}) or use find_user_by_name` : ""}:`,
      ...lines,
    ].join("\n"),
    data: { total, users },
  };
}

// Slack status text that means the person is not around.
const AWAY_STATUS = /vacation|holiday|leave|sick|ill\b|ooo|out of office|off work|away|travell?ing|day off|pto/i;

// One person's room for work, as getTeamAvailability gives it for the team.
export async function getAvailability(env: AppEnv, user: string, { user_id, project, fields }: GetAvailabilityArgs) {
  if (!/^[UW][A-Z0-9]{2,}$/.test(String(user_id ?? "")))
    throw new ToolError("user_id is a Slack user ID such as U0123ABCD. find_user_by_name gives them.");
  const result = await getTeamAvailability(env, user, { users: [user_id], project, fields });
  if (!result.data.people.length)
    throw new ToolError(
      project !== undefined
        ? `${user_id} isn't in ${project}'s channel, or isn't an active person in the workspace.`
        : `There is no active person ${user_id} in the workspace.`,
    );
  return {
    text: result.text.split("\n").slice(1).join("\n").replace(/^1\. /, ""),
    data: { person: result.data.people[0] },
  };
}

// Who in the team has room for work: each person's open tasks, their Slack status and, if asked, presence.
export async function getTeamAvailability(
  env: AppEnv,
  user: string,
  { users, project, fields, limit }: GetTeamAvailabilityArgs,
) {
  if (fields !== undefined && !(Array.isArray(fields) && fields.every((field) => AVAILABILITY_FIELDS.includes(field))))
    throw new ToolError(`fields is a list of: ${AVAILABILITY_FIELDS.join(", ")}.`);
  const presence = fields?.includes("presence") ?? false;
  const shown = fields ?? AVAILABILITY_FIELDS.filter((field) => field !== "presence");
  if (users !== undefined && !(Array.isArray(users) && users.every((id) => /^[UW][A-Z0-9]{2,}$/.test(String(id)))))
    throw new ToolError("users is a list of Slack user IDs such as U0123ABCD. find_user_by_name gives them.");
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= MAX_USERS))
    throw new ToolError(`limit is a whole number from 1 to ${MAX_USERS}.`);
  // A project's people are those in its channel (a private one's only for someone in it to ask about), and
  // asking for others in it finds no one.
  const channel = project !== undefined ? (await readableProject(env, user, project)).channel : undefined;
  const team = channel
    ? await channelMembers(env, channel).catch((error) => {
        throw new ToolError(`I couldn't read who is in ${project}'s channel (${error.message}).`);
      })
    : null;
  const wanted = team
    ? new Set<string>((users ?? team).filter((id: string) => team.includes(id)))
    : users
      ? new Set<string>(users)
      : null;

  const members: SlackUser[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await callSlack(env, "users.list", { limit: PAGE, ...(cursor && { cursor }) }).catch((error) => {
      throw new ToolError(`I couldn't list the workspace's people (${error.message}).`);
    });
    for (const member of result.members ?? []) {
      if (member.deleted || member.is_bot || member.id === "USLACKBOT") continue;
      if (wanted && !wanted.has(member.id)) continue;
      members.push(member);
    }
    cursor = result.response_metadata?.next_cursor;
    if (!cursor) break;
  }

  // Every open task counts, in channels you aren't in too: someone's load is all their work, and only
  // numbers are given, never which tasks. With a project, only its channel's.
  const today = todayIn(env);
  const load = new Map<
    string,
    { owner: number; reviewer: number; tester: number; overdue: Set<string>; hot: Set<string>; all: Set<string> }
  >();
  for (const { channel: where, ts, task } of await tasksWithStatuses(env, OPEN)) {
    if (channel && where !== channel) continue;
    const due = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(task.dueDate ?? "");
    const late = Boolean(due) && `${due![3]}-${due![2]}-${due![1]}` < today;
    for (const role of Object.keys(ROLES) as Role[]) {
      for (const id of task.people[role]) {
        const mine = load.get(id) ?? {
          owner: 0,
          reviewer: 0,
          tester: 0,
          overdue: new Set<string>(),
          hot: new Set<string>(),
          all: new Set<string>(),
        };
        const key = where + ts;
        mine[role]++;
        mine.all.add(key);
        if (late) mine.overdue.add(key);
        if (["Urgent", "High"].includes(task.priority)) mine.hot.add(key);
        load.set(id, mine);
      }
    }
  }

  const now = Date.now() / 1000;
  let people: {
    user_id: string;
    name: string;
    open_tasks: number;
    owner: number;
    reviewer: number;
    tester: number;
    overdue: number;
    urgent_or_high: number;
    status: string;
    status_until: string;
    time_zone: string;
    away: boolean;
    presence?: string;
  }[] = members.map((member) => {
    const mine = load.get(member.id);
    const status = member.profile?.status_text ?? "";
    const until = member.profile?.status_expiration;
    const active = status && (!until || until > now);
    return {
      user_id: member.id,
      name: member.real_name ?? member.profile?.real_name ?? member.name ?? "",
      open_tasks: mine?.all.size ?? 0,
      owner: mine?.owner ?? 0,
      reviewer: mine?.reviewer ?? 0,
      tester: mine?.tester ?? 0,
      overdue: mine?.overdue.size ?? 0,
      urgent_or_high: mine?.hot.size ?? 0,
      status: active ? status : "",
      status_until: active && until ? new Date(until * 1000).toISOString().slice(0, 10) : "",
      time_zone: member.tz ?? "",
      away: Boolean(active && AWAY_STATUS.test(status)),
    };
  });
  const total = people.length;
  // Booleans subtract as 0 and 1: those away go last.
  people.sort(
    (a, b) =>
      Number(a.away) - Number(b.away) ||
      a.open_tasks - b.open_tasks ||
      a.urgent_or_high - b.urgent_or_high ||
      a.overdue - b.overdue ||
      a.name.localeCompare(b.name),
  );
  people = people.slice(0, limit ?? DEFAULT_USERS);

  if (presence) {
    if (people.length > MAX_PRESENCE)
      throw new ToolError(
        `presence looks up each person in Slack, so it takes at most ${MAX_PRESENCE} people. Pass users or a smaller limit.`,
      );
    await Promise.all(
      people.map(async (person) => {
        const result = await callSlack(env, "users.getPresence", { user: person.user_id }).catch(() => null);
        person.presence = result?.presence === "active" ? "active" : result?.presence === "away" ? "away" : "unknown";
      }),
    );
  }
  if (!people.length) return { text: "No one matches.", data: { total: 0, people: [] } };
  const lines = people.map((person, index) => {
    const has = (field: string) => shown.includes(field);
    const parts: string[] = [];
    if (has("open_tasks"))
      parts.push(
        `${person.open_tasks} open${has("owner") || has("reviewer") || has("tester") ? ` (owner ${person.owner}, reviewer ${person.reviewer}, tester ${person.tester})` : ""}`,
      );
    if (has("overdue") && person.overdue) parts.push(`${person.overdue} overdue`);
    if (has("urgent_or_high") && person.urgent_or_high) parts.push(`${person.urgent_or_high} urgent/high`);
    if (has("status") && person.status)
      parts.push(
        `status: ${person.status}${has("status_until") && person.status_until ? ` until ${person.status_until}` : ""}`,
      );
    if (has("away") && person.away) parts.push("away");
    if (person.presence) parts.push(person.presence);
    if (has("time_zone") && person.time_zone) parts.push(person.time_zone);
    return `${index + 1}. ${has("name") ? `${person.name} (${person.user_id})` : person.user_id}${parts.length ? `: ${parts.join("; ")}` : ""}`;
  });
  const more = total > people.length ? `\n…and ${total - people.length} more; raise limit or pass users.` : "";
  const out = people.map((person) =>
    Object.fromEntries(Object.entries(person).filter(([key]) => key === "user_id" || shown.includes(key))),
  );
  return {
    text:
      [`${people.length} ${people.length === 1 ? "person" : "people"}, least loaded first:`, ...lines].join("\n") +
      more,
    data: { total, people: out },
  };
}
