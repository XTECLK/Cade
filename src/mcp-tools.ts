import {PRIORITIES, ROLES, STATUSES} from "./tasks.ts";

// What each of Cade's MCP tools takes and gives, for src/mcp.ts, which runs them: a tool's name,
// description, `inputSchema` (its arguments) and `outputSchema` (the `structuredContent` of its
// result). The text is for people and agents that read it, `structuredContent` is for passing on.
// A default is in a description, and applied by the tool itself.
//
// The file reads from the top down: the numbers, the lists of allowed values, the builders for a
// field, the shapes the tools share, and then the tools.

// ── Numbers ──────────────────────────────────────────────────────────────────────────────────

// How many to return: a default, and the most that can be asked for.
export const DEFAULT_TASKS = 20;
export const MAX_TASKS = 100;
export const DEFAULT_USERS = 50;
export const MAX_USERS = 200;
export const DEFAULT_CHANNELS = 50;
export const MAX_CHANNELS = 200;
export const DEFAULT_THREADS = 10;
export const MAX_THREADS = 50;
export const DEFAULT_DAYS = 14;
export const MAX_DAYS = 90;
export const MAX_PRESENCE = 50; // people whose Slack presence is looked up, one call each
export const MAX_MATCHES = 10; // people find_user_by_name gives
export const MAX_NAMES = 50; // people whose names a result carries

// How long a text can be, in characters.
export const MAX_TITLE = 150;
export const MAX_SUMMARY = 8000;
export const MAX_MESSAGE = 3000;
export const MAX_PREVIEW = 300; // the start of a thread's first message

// How many entries a list can hold.
export const MAX_ASSIGNEES = 50; // people get_tasks is asked about

// ── Allowed values ───────────────────────────────────────────────────────────────────────────

// From tasks.ts.
const STATUS_NAMES = Object.keys(STATUSES);
const PRIORITY_NAMES = Object.keys(PRIORITIES);
const ROLE_NAMES = Object.keys(ROLES);

// One of get_tasks' assignees: a Slack user ID, or "me" for whoever's API key it is.
const ASSIGNEE_PATTERN = "^(me|[UW][A-Z0-9]{2,})$";

// A task's status in get_tasks: also open (everything not done) and all.
const TASK_STATUS_FILTER = ["open", "all", ...STATUS_NAMES];

// Where a pull request stands on GitHub (see github.ts).
const PR_STATES = ["OPEN", "MERGED", "CLOSED"];

// Whether a session has the latest tool set.
const SESSION_STATUSES = ["CURRENT", "OUTDATED", "UNKNOWN"];

// Where a task came from, and who is around.
const ORIGINAL_THREAD_STATES = ["found", "none", "unknown"];
const PRESENCES = ["active", "away", "unknown"];

// What get_users and find_user_by_name can give for each person, besides user_id.
export const USER_FIELDS = ["name", "username"];

// What get_availability and get_team_availability can give for each person, besides user_id.
export const AVAILABILITY_FIELDS = ["name", "open_tasks", "owner", "reviewer", "tester", "overdue", "urgent_or_high", "status", "status_until", "time_zone", "away", "presence"];

// ── Builders for a field ─────────────────────────────────────────────────────────────────────

// A JSON Schema, as the tools' inputSchema and outputSchema hold them (see validate.ts).
import type { Schema } from "./validate.ts";
export type { Schema };

const str = (description: string, extra?: Schema): Schema => ({type: "string", ...extra, description});
const int = (description: string, extra?: Schema): Schema => ({type: "integer", ...extra, description});
const bool = (description: string): Schema => ({type: "boolean", description});
const strings = (description: string): Schema => ({type: "array", items: {type: "string"}, description});
const choice = (description: string, values: readonly (string | null)[], extra?: Schema): Schema => ({type: "string", enum: values, ...extra, description});
const list = (description: string, items: Schema, extra?: Schema): Schema => ({type: "array", ...extra, description, items});
const choices = (description: string, values: readonly string[]): Schema => ({type: "array", items: {type: "string", enum: values}, description});
const outputOf = (properties: Record<string, Schema>): Schema => ({type: "object", properties, required: Object.keys(properties)});

// The names of the people whose user IDs a result holds, so the agent can show names without a lookup
// for each. mcp.ts fills it in for every tool whose result has this property.
const USER_NAMES = {
    type: "object",
    description: `The names of the people whose user IDs, or <@…> mentions, are in this result, by user ID (at most ${MAX_NAMES}; for any other ID use get_user). Show the name, never the ID`,
    additionalProperties: {type: "string"},
};
const outputWithNames = (properties: Record<string, Schema>) => outputOf({...properties, user_names: USER_NAMES});

// ── Shapes the tools share ───────────────────────────────────────────────────────────────────

// Property maps come first: a map is not an object of its own, but the `properties` of one or spread
// into one. (EXTRA_FIELDS is the exception: it holds PR_ITEM, so it comes right after that.)

const THREAD = {
    type: ["object", "null"],
    description: "The thread a task was made from, or null",
    properties: {thread_id: str("The thread's ID, for get_thread_history"), link: str("A link to the thread")},
};

// A subtask's parent, or one of a task's subtasks: enough to read it with get_task, and its thread
// with get_task_history.
const TASK_LINK = {
    task_id: str("The task's ID, for get_task and get_task_history"),
    title: str("The task's title"),
    link: str("A link to the task's message"),
};
const PARENT = {
    type: ["object", "null"],
    description: "The task this one is a subtask of, or null",
    properties: TASK_LINK,
};
const SUBTASK_ITEM = {
    type: "object",
    description: "A subtask: a part of the task, or an issue found while testing it, with its own thread",
    properties: {...TASK_LINK, status: choice("The subtask's status", STATUS_NAMES)},
    required: ["task_id", "title", "link", "status"],
};

const MESSAGE_PROPERTIES = {
    ts: str("Slack's message time"),
    time: str("When it was sent (YYYY-MM-DD HH:MM, UTC)"),
    user_id: str("The sender: a Slack user ID (show the name, not the ID), a bot's name or ID, or unknown"),
    bot: bool("Whether a bot sent it"),
    text: str("What it says, with <@U…> mentions as sent"),
    files: strings("Names of attached files"),
    links: strings("The web addresses in the message, once each. Cade doesn't open them: read them with your own tools, as the person"),
};

const MESSAGE_ITEM = {
    type: "object",
    description: "A message in a thread",
    properties: MESSAGE_PROPERTIES,
    required: ["ts", "time", "user_id", "bot", "text", "files", "links"],
};

// A message of a task's thread for its summary: one Cade copied in from another thread names it.
const SUMMARY_MESSAGE_ITEM = {
    type: "object",
    description: "A message in the task's thread",
    properties: {
        ...MESSAGE_PROPERTIES,
        moved_from: {
            type: ["object", "null"],
            description: "Set when this message is Cade's copy of the first message of another thread, moved into the task: that thread, or null",
            properties: {thread_id: str("The thread's ID, for get_thread_history"), link: str("A link to the message moved")},
        },
    },
    required: ["ts", "time", "user_id", "bot", "text", "files", "links", "moved_from"],
};

const PERSON = {
    type: "object",
    description: "A person in the workspace",
    properties: {
        user_id: str("A Slack user ID, show the name, not the ID"),
        name: str("Real name"),
        username: str("Slack username")
    },
    required: ["user_id"],
};
const USER_FIELDS_ARG = choices("Only these fields for each person, to keep the result small; user_id is always there. Default: all", USER_FIELDS);

const AVAILABILITY_PERSON = {
    type: "object",
    description: "A person's load and availability",
    properties: {
        user_id: str("A Slack user ID, show the name, not the ID"),
        name: str("Real name"),
        open_tasks: int("Open tasks they are owner, reviewer or tester of"),
        owner: int("Open tasks they are the owner of"),
        reviewer: int("Open tasks they are the reviewer of"),
        tester: int("Open tasks they are the tester of"),
        overdue: int("Open tasks past their due date"),
        urgent_or_high: int("Open Urgent or High priority tasks"),
        status: str("Their Slack status text, or empty"),
        status_until: str("When the status ends, in UTC, or empty (YYYY-MM-DD)"),
        time_zone: str("Their time zone, such as Asia/Colombo"),
        presence: choice("Only when asked for in fields. 'away' often only means Slack is closed, so it is a weak sign that someone is unavailable", PRESENCES),
        away: bool("Whether the status text suggests vacation, sick leave or being out of office: don't assign someone who is away"),
    },
    required: ["user_id"],
};
const AVAILABILITY_FIELDS_ARG = choices("The fields to give, to keep the result small; user_id is always there. Default: all but presence. Add presence to look up whether the person is active in Slack right now (one Slack call each)", AVAILABILITY_FIELDS);

const PR_ITEM = {
    type: "object",
    description: "A pull request linked to the task",
    properties: {
        url: str("The pull request's address"),
        label: str("repo/number"),
        state: choice("Where it stands on GitHub, as Cade last read it: OPEN (drafts too, and any Cade can't read, such as GitLab's), MERGED, or CLOSED without merging", PR_STATES),
    },
    required: ["url", "label", "state"],
};

// A property map: what get_tasks can include for each task, besides its task_id and the base fields.
export const EXTRA_FIELDS = {
    created_by: str("Who raised it: a Slack user ID, show the name, not the ID"),
    prs: list("The pull requests linked to the task, each with where it stands", PR_ITEM),
    completed_at: str("When it was marked Done, or empty (YYYY-MM-DD HH:MM, UTC)"),
};

const TASK_ITEM = {
    type: "object",
    description: "A task",
    properties: {
        task_id: str("The task's ID, for the other tools"),
        title: str("The task's title"),
        project: str("The project's name"),
        channel_id: str("The task's channel ID"),
        status: choice("The task's status", STATUS_NAMES),
        priority: choice("The task's priority", PRIORITY_NAMES),
        due_date: str("DD/MM/YYYY, or empty for none"),
        incident: bool("Whether it is an incident: something broken now, always Urgent"),
        blocked: bool("Whether it is blocked: it keeps its status and shows as blocked on its card"),
        blocked_reason: str("Why it is blocked, in a short phrase, or empty"),
        link: str("A link to the task's message"),
        owner: strings("The task's owners, as Slack user IDs: show their names, not the IDs. A subtask with no owner of its own has its task's"),
        reviewer: strings("The task's reviewers, as Slack user IDs: show their names, not the IDs"),
        tester: strings("The task's testers, as Slack user IDs: show their names, not the IDs"),
        parent: PARENT,
    },
    required: ["task_id", "title", "status", "priority", "due_date", "incident", "link", "owner", "reviewer", "tester"],
};

export const TASK_FIELDS = [...Object.keys(TASK_ITEM.properties).filter((key) => key !== "task_id"), ...Object.keys(EXTRA_FIELDS)];
// get_task can also give where the task came from.
export const TASK_VIEW_FIELDS = [...TASK_FIELDS, "original_thread", "original_thread_state", "subtasks"];

// ── Annotations ──────────────────────────────────────────────────────────────────────────────

// What a client may assume of a tool (MCP's annotations): a reader changes nothing; the writers
// post in Slack or change a task, which the descriptions say to do only once the person approves.
const READS = {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false};
const READS_SLACK = {...READS, openWorldHint: true};

// ── The tools ────────────────────────────────────────────────────────────────────────────────

// One of Cade's MCP tools, as tools/list gives it.
export interface ToolDef {
    name: string;
    title: string;
    annotations: Record<string, boolean>;
    description: string;
    inputSchema: Schema;
    outputSchema: Schema;
}

export const TOOL_DEFS: ToolDef[] = [
    {
        name: "get_task",
        title: "Get a task",
        annotations: READS,
        description:
            "Reads one task from Cade's own database: its details, people, links and pull requests, as they are now. For what the task is about, get_task_summary gives its summary. It includes no thread, but names the one the task was made from, which get_thread_history reads. It names the task's subtasks too (parts of it, or issues found while testing it), each with its own thread, which get_task_history reads: read them as well to know how the whole task went, such as for an executive summary.",
        inputSchema: {
            type: "object",
            properties: {
                task_id: str("The task's ID, channel and message time joined by a colon, such as C0123ABCD:1700000000.000100"),
                fields: choices("Only these fields, to keep the result small; task_id is always there. Default: all", TASK_VIEW_FIELDS),
            },
            required: ["task_id"],
        },
        outputSchema: {
            type: "object",
            required: ["task_id"],
            properties: {
                ...TASK_ITEM.properties,
                user_names: USER_NAMES,
                created_by: str("Who raised it: a Slack user ID, show the name, not the ID"),
                completed_at: str("When it was marked Done, or empty (YYYY-MM-DD HH:MM, UTC)"),
                original_thread_state: choice("found: original_thread names it; none: made from no other thread; unknown: no messages kept yet", ORIGINAL_THREAD_STATES),
                original_thread: THREAD,
                prs: list("The pull requests linked to the task, each with where it stands", PR_ITEM),
                subtasks: list("The task's subtasks (parts of it, or issues found while testing it), oldest first, Done ones too, each with its own thread for get_task_history", SUBTASK_ITEM),
            },
        },
    },
    {
        name: "get_thread_history",
        title: "Read a Slack thread",
        annotations: READS_SLACK,
        description:
            "Reads a whole Slack thread from Slack, oldest message first, in a channel you are in, or one a message was moved from into a task you can read (get_task_summary names them). If Cade isn't in the channel, read it with your own Slack tools, as the person. Slack's free plan hides messages older than 90 days; for a task Cade tracks, get_task_history has the messages Cade kept.",
        inputSchema: {
            type: "object",
            properties: {
                thread_id: str("The thread's ID, channel and message time joined by a colon, such as C0123ABCD:1700000000.000100"),
                link: str("Instead of thread_id: a link to a message in the thread, such as https://team.slack.com/archives/C0123ABCD/p1700000000123456"),
            },
            anyOf: [{required: ["thread_id"]}, {required: ["link"]}],
        },
        outputSchema: outputWithNames({
            thread_id: str("The thread's ID, for get_thread_history"),
            channel_name: str("The channel's name"),
            messages: list("Oldest first", MESSAGE_ITEM),
        }),
    },
    {
        name: "get_task_history",
        title: "Read a task's thread",
        annotations: READS,
        description:
            "Reads the messages Cade kept of a task's own thread, oldest first: what was done about the task, or only what came after a message with since. Unlike get_thread_history it doesn't ask Slack, so it still has messages Slack hides after 90 days. For a task's summary, get_task_summary gives the messages it needs.",
        inputSchema: {
            type: "object",
            properties: {
                task_id: str("The task's ID, channel and message time joined by a colon, such as C0123ABCD:1700000000.000100"),
                since: str("Only the messages after this one, by its ts (Slack's message time, such as 1700000000.000100). Default: every message", {pattern: "^\\d{10}\\.\\d{6}$"}),
            },
            required: ["task_id"],
        },
        outputSchema: outputWithNames({
            task_id: str("The task's ID, for the other tools"),
            title: str("The task's title"),
            messages: list("Oldest first", MESSAGE_ITEM),
            original_thread: THREAD,
        }),
    },
    {
        name: "get_task_summary",
        title: "Get a task's summary",
        annotations: READS,
        description:
            "Gives a task's saved summary (whose agent saved it, when, and up to which message of the task's thread it covers) and the messages of the task's thread after that one, oldest first; with no summary saved, or with full, every message and no summary. A message Cade copied in from another thread names that thread in moved_from. save_task_summary saves a summary with the through given here. When the team has steps for writing it, prompt names them, for get_prompt.",
        inputSchema: {
            type: "object",
            properties: {
                task_id: str("The task's ID, channel and message time joined by a colon, such as C0123ABCD:1700000000.000100"),
                full: bool("Leave out the saved summary and give every message of the task's thread. Default false"),
            },
            required: ["task_id"],
        },
        outputSchema: outputWithNames({
            task_id: str("The task's ID, for the other tools"),
            title: str("The task's title"),
            summary: str("The summary saved so far, or empty when there is none or with full"),
            summary_by: str("Whose agent saved it, or empty: a Slack user ID, show the name, not the ID"),
            summary_at: str("When it was saved, or empty (YYYY-MM-DD HH:MM, UTC)"),
            summary_through: str("The last message of the task's thread the saved summary covers, or empty when none is saved"),
            up_to_date: bool("Whether the saved summary covers every message: then there is nothing new to add"),
            messages: list("The messages the summary doesn't cover yet (all of them with no summary or with full), oldest first", SUMMARY_MESSAGE_ITEM),
            through: str("The last message of the task's thread given, or the saved summary's when none is new: for save_task_summary. Empty when the task's thread has no messages kept"),
            prompt: str("The prompt with the team's steps for a task's summary, for get_prompt with the task as its task argument, or empty when the team has none"),
        }),
    },
    {
        name: "save_task_summary",
        title: "Save a task's summary",
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false},
        description:
            "Saves a task's summary, covering its thread up to through, in place of the one saved. It is kept for agents, not posted in Slack or shown on a page, so unlike other writes it needs no approval. Anyone who can read the task's channel gets it through their agent. Refused when the one saved covers more of the thread.",
        inputSchema: {
            type: "object",
            properties: {
                task_id: str("The task's ID, channel and message time joined by a colon, such as C0123ABCD:1700000000.000100"),
                summary: str(`The summary, as plain text. At most ${MAX_SUMMARY} characters`),
                through: str("The last message of the task's thread it covers: the through get_task_summary gave"),
            },
            required: ["task_id", "summary", "through"],
        },
        outputSchema: outputOf({
            task_id: str("The task's ID, for the other tools"),
            saved: bool("Whether it was saved"),
        }),
    },
    {
        name: "get_tasks",
        title: "List tasks",
        annotations: READS,
        description:
            "Lists Cade tasks in the channels you are in, most urgent first, open ones by default: everyone's, or those of the people in assignees (\"me\" for your own), in any role or those in roles. It can also give the tasks done in a period, with those not done, for an executive summary. " +
            "The list is flat: a subtask is listed as any task is, naming its parent. get_task gives a task's subtasks.",
        inputSchema: {
            type: "object",
            properties: {
                assignees: list("Only tasks one of these people is on, in one of roles. \"me\" is you, so [\"me\"] gives your own tasks", str("a Slack user ID such as U0123ABCD, or me", {pattern: ASSIGNEE_PATTERN}), {
                    minItems: 1,
                    maxItems: MAX_ASSIGNEES
                }),
                roles: list("With assignees: only the tasks where one of them has one of these roles. Default: all three", choice("A role", ROLE_NAMES), {minItems: 1}),
                unassigned: bool("Only tasks nobody is owner, reviewer or tester of. Can't be combined with assignees"),
                status: choice("open (default: everything not done), all, or one status", TASK_STATUS_FILTER),
                project: str("Only this project's tasks, by the name get_projects gives"),
                completed_from: str("Only tasks marked Done on or after this day (status defaults to DONE then) (YYYY-MM-DD)"),
                completed_to: str("Only tasks marked Done on or before this day (YYYY-MM-DD)"),
                include_open: bool("With completed_from or completed_to: give the tasks not done too, listed first, as well as those done in the days. Can't be combined with status"),
                fields: choices(`The fields to give for each task, besides task_id which is always there. Default: all but ${Object.keys(EXTRA_FIELDS).join(", ")}`, TASK_FIELDS),
                limit: int(`How many tasks to return, most urgent first. Default ${DEFAULT_TASKS}`, {
                    minimum: 1,
                    maximum: MAX_TASKS
                }),
            },
        },
        outputSchema: outputWithNames({
            total: int("How many tasks match and you can see"),
            tasks: list("The ones shown, grouped by project, most urgent first within each", {
                type: "object",
                properties: {...TASK_ITEM.properties, ...EXTRA_FIELDS},
                required: ["task_id"],
                description: "Every field, or just those asked for in fields"
            }),
        }),
    },
    {
        name: "get_channels",
        title: "List channels",
        annotations: READS_SLACK,
        description:
            "Lists the Slack channels Cade and you are both in, project channels first. It is where to start to browse for conversations that should become tasks: pick a channel, then read its threads with get_channel_threads.",
        inputSchema: {
            type: "object",
            properties: {
                limit: int(`How many channels to return. Default ${DEFAULT_CHANNELS}`, {
                    minimum: 1,
                    maximum: MAX_CHANNELS
                })
            },
        },
        outputSchema: outputOf({
            total: int("How many channels Cade and you are both in"),
            channels: list("Project channels first, then by name", {
                type: "object",
                description: "A channel Cade is in",
                properties: {
                    channel_id: str("A Slack channel ID, such as C0123ABCD"),
                    name: str("The channel's name"),
                    private: bool("Whether the channel is private"),
                    project: str("Set if this is a project's channel, else empty")
                },
                required: ["channel_id", "name", "private", "project"],
            }),
        }),
    },
    {
        name: "get_channel_threads",
        title: "List a channel's recent threads",
        annotations: READS_SLACK,
        description:
            "Lists a channel's recent conversations that Cade doesn't track as tasks, newest first. Use it to find conversations that should become tasks: read one with get_thread_history and make the task with create_task.",
        inputSchema: {
            type: "object",
            properties: {
                channel_id: str("The channel's ID, as get_channels gives it, such as C0123ABCD"),
                days: int(`How many days back to look. Default ${DEFAULT_DAYS}`, {minimum: 1, maximum: MAX_DAYS}),
                with_replies: bool("Only the messages that have replies, the conversations that happened. Default false: every message of people"),
                limit: int(`How many threads to return, newest first. Default ${DEFAULT_THREADS}`, {
                    minimum: 1,
                    maximum: MAX_THREADS
                }),
            },
            required: ["channel_id"],
        },
        outputSchema: outputWithNames({
            channel_id: str("A Slack channel ID, such as C0123ABCD"),
            channel_name: str("The channel's name"),
            total: int("How many matching threads there are in that time"),
            threads: list("Newest first", {
                type: "object",
                description: "A conversation that is not a task",
                properties: {
                    thread_id: str("For get_thread_history and create_task"),
                    time: str("When it was sent (YYYY-MM-DD HH:MM, UTC)"),
                    user_id: str("A Slack user ID, show the name, not the ID"),
                    text: str(`The start of what it says, up to ${MAX_PREVIEW} characters, with <@U…> mentions as sent`),
                    files: strings("Names of attached files"),
                    reply_count: int("How many replies it has"),
                    last_reply: str("When the last reply was sent, or empty for none (YYYY-MM-DD HH:MM, UTC)"),
                },
                required: ["thread_id", "time", "user_id", "text", "files", "reply_count", "last_reply"],
            }),
        }),
    },
    {
        name: "create_task",
        title: "Create a task",
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true},
        description:
            "Creates a task, or an incident, in a project's channel as the person you act for: from a Slack thread (moved into the new task) or from scratch. An incident is always Urgent and due immediately. " +
            "Suggest the title, priority and due date and ask for the person's input, and call this only with a task the person has seen and approved. Check with get_tasks that the task doesn't exist already. Each call makes a new task. Offer to assign people afterwards with update_task. " +
            "With parent_task_id it makes a subtask of that task instead (a part of it, or an issue found while testing it): in the task's project, with its own card and thread, starting with the task's people and due date (give another if it is due earlier or later), and with its priority for good, which follows the task's; the task's thread is told, with a link. Subtasks go one level deep, and a subtask of an incident is an incident too. A task moves to Client review or Done only once all its subtasks are Done. " +
            "Preview: kind (task or incident), title, project, priority, due date (or none), the thread it comes from, and the task it is a subtask of, if any.",
        inputSchema: {
            type: "object",
            properties: {
                title: str("One short line saying what has to be done", {maxLength: MAX_TITLE}),
                project: str("The project to make it in, by the name get_projects gives. Can be left out when the thread is in a project's channel or there is only one project"),
                priority: choice("Default Medium. Not for an incident", PRIORITY_NAMES),
                due_date: str("DD/MM/YYYY or YYYY-MM-DD. Use a date the thread gives or clearly implies, never an invented one; leave out for none. Not for an incident"),
                incident: bool("Make an incident: only for something broken now that blocks people or the business, always Urgent and due immediately. When unsure, leave it false (a task). Default false"),
                thread_id: str("The thread to make it from. One that is already a task, was moved into one, or is a bot's or a direct message can't be used"),
                link: str("Instead of thread_id: a link to a message in the thread"),
                parent_task_id: str("Make it a subtask of this task, by the ID get_tasks gives. Leave out project and priority (it has the task's); due_date defaults to the task's"),
            },
            required: ["title"],
        },
        outputSchema: outputOf({
            task_id: str("The task's ID, for the other tools"),
            link: str("A link to the task's message"),
            project: str("The project's name"),
            incident: bool("Whether it was made as an incident"),
            parent_task_id: {type: ["string", "null"], description: "The task it is a subtask of, or null"},
        }),
    },
    {
        name: "get_projects",
        title: "List projects",
        annotations: READS,
        description:
            "Lists the projects Cade tracks tasks for whose channel you are in.",
        inputSchema: {type: "object", properties: {}},
        outputSchema: outputOf({
            total: int("How many projects you can see"),
            projects: list("The projects you can see", {
                type: "object",
                description: "A project",
                properties: {name: str("The project's name"), channel_id: str("The project's channel ID")},
                required: ["name", "channel_id"]
            }),
        }),
    },
    {
        name: "get_user",
        title: "Get a user",
        annotations: READS_SLACK,
        description:
            "Gives a Slack user's name from their ID or mention, and with profile also their email, phone number and job title.",
        inputSchema: {
            type: "object",
            properties: {
                user_id: str("A Slack user ID such as U0123ABCD, or a <@…> mention"),
                profile: bool("Also give their email, phone number and title. Private: ask for it only when needed, such as to reach someone on WhatsApp (https://wa.me/<number with country code, digits only>?text=<URL-encoded message> opens the chat). Default false"),
            },
            required: ["user_id"],
        },
        outputSchema: outputOf({
            user_id: str("A Slack user ID, show the name, not the ID"),
            name: str("Real name"),
            handle: str("Display name, or empty"),
            profile: {
                type: ["object", "null"],
                description: "Only when asked for with profile, otherwise null",
                properties: {email: str("Or empty"), phone: str("Or empty"), title: str("Or empty")}
            },
        }),
    },
    {
        name: "get_users",
        title: "List users",
        annotations: READS_SLACK,
        description:
            "Lists the people of the Slack workspace with their user IDs, leaving out bots and deactivated accounts. In a large workspace use find_user_by_name instead.",
        inputSchema: {
            type: "object",
            properties: {
                limit: int(`How many people to return. Default ${DEFAULT_USERS}`, {
                    minimum: 1,
                    maximum: MAX_USERS
                }), fields: USER_FIELDS_ARG
            },
        },
        outputSchema: outputOf({
            total: int("How many people there are"),
            users: list("The people, with their user IDs", PERSON)
        }),
    },
    {
        name: "get_team_availability",
        title: "Who in the team is available",
        annotations: READS_SLACK,
        description:
            "Shows who in the team has room for work, least loaded first: their open tasks, how many are overdue or urgent, their Slack status and time zone. Use it to pick whom to assign a task to.",
        inputSchema: {
            type: "object",
            properties: {
                users: strings("Only these people, as Slack user IDs such as U0123ABCD"),
                project: str("Count only this project's tasks, and cover only the people in its channel. The project's name, as get_projects gives it"),
                fields: AVAILABILITY_FIELDS_ARG,
                limit: int(`How many people to return, least loaded first. Default ${DEFAULT_USERS}`, {
                    minimum: 1,
                    maximum: MAX_USERS
                }),
            },
        },
        outputSchema: outputOf({
            total: int("How many people were looked at"),
            people: list("Least loaded first, people with an away status last", AVAILABILITY_PERSON),
        }),
    },
    {
        name: "get_availability",
        title: "Is a person available",
        annotations: READS_SLACK,
        description:
            "Shows how much room one person has for work: their open tasks, how many are overdue or urgent, their Slack status and time zone. To compare the whole team use get_team_availability.",
        inputSchema: {
            type: "object",
            properties: {
                user_id: str("The person, as a Slack user ID such as U0123ABCD"),
                project: str("Count only this project's tasks; the person must be in its channel. The project's name, as get_projects gives it"),
                fields: AVAILABILITY_FIELDS_ARG,
            },
            required: ["user_id"],
        },
        outputSchema: outputOf({person: AVAILABILITY_PERSON}),
    },
    {
        name: "find_user_by_name",
        title: "Find a user by name",
        annotations: READS_SLACK,
        description:
            "Finds people in the Slack workspace by part of their name and gives each one's user ID, which update_task takes to assign someone and get_tasks takes in assignees.",
        inputSchema: {
            type: "object",
            properties: {name: str("Part of the person's name, such as Ann or ann.lee"), fields: USER_FIELDS_ARG},
            required: ["name"],
        },
        outputSchema: outputOf({
            total: int("How many people match"),
            users: list(`Up to ${MAX_MATCHES} of them`, PERSON)
        }),
    },
    {
        name: "send_thread_message",
        title: "Post in a thread",
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true},
        description:
            "Posts a message in a Slack thread as Cade, led by who it is from and with a \"Sent using AI agent\" footer: a task's own thread, or any other thread in a channel the person is in. A mention notifies that person; @channel, @here and @everyone are not sent as mentions. " +
            "If you can also post as the person with Slack tools of your own, ask them which they want first. " +
            "In a task's thread, check first whether the message or the work means the task's status or pull requests should change, and offer that with update_task in the same preview: Cade suggests nothing from an agent's message. " +
            "Without Slack tools of your own, use this and say how it will show. " +
            "Preview: the task, or the channel and link of a thread that isn't a task, the whole message as it will be posted, and whether it goes as the person or via Cade. " +
            "Call this only with text the person has seen and approved.",
        inputSchema: {
            type: "object",
            properties: {
                thread_id: str("The thread's ID, channel and message time joined by a colon, such as C0123ABCD:1700000000.000100. A task's ID is its thread's"),
                link: str("Instead of thread_id: a link to a message in the thread, such as https://team.slack.com/archives/C0123ABCD/p1700000000123456"),
                text: str(`The message, as plain text, written as the person would. Mention a person as <@U0123ABCD>, with their user ID and never their name: only the ID notifies them, and a name written out notifies no one. The preview shows the name, but the call keeps the ID. At most ${MAX_MESSAGE} characters`),
            },
            required: ["text"],
            anyOf: [{required: ["thread_id"]}, {required: ["link"]}],
        },
        outputSchema: outputOf({
            task_id: str("The task's ID, for the other tools, or empty when the thread isn't a task"),
            thread_id: str("The thread's ID, for get_thread_history"),
            sent: bool("Whether the message was posted"),
            link: str("A link to the thread, or empty when Slack wouldn't give one")
        }),
    },
    {
        name: "update_task",
        title: "Update a task",
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true},
        description:
            "Changes a task in one call: its status, priority, due date, people and pull requests. Cade posts the changes in the task's thread. Its summary is save_task_summary's. " +
            "Cade doesn't ask anyone to do anything: when the change means asking people (picking it up, reviewing, testing), suggested_message has the request. Ask the person whether to send it, as it is, in their own words or not at all (they may know it isn't needed), and send their version with send_thread_message only after a clear yes. " +
            "A task with open subtasks can't move to Client review or Done: the call is refused, naming them. Ask the person whether to close them; if they agree, set each to DONE (with the usual preview), then move the task. " +
            "Keeping it in step with the thread and the work: a status the evidence has moved past (To do when work has started, In progress when a pull request is up for review, or a message saying \"ready for review\", \"QA passed\" or \"done\"); a pull request mentioned or opened for it and not linked, to add; one linked and still open but replaced by another, or for another task, to remove. Offer nothing from a plan, a question or a guess. " +
            "Preview: the task, then each field you change as old -> new with the reason (status, priority, due date, owner, reviewer, tester, pull requests), and nothing left unchanged. " +
            "Call this only with changes the person has seen and approved.",
        inputSchema: {
            type: "object",
            properties: {
                task_id: str("The task's ID, channel and message time joined by a colon, such as C0123ABCD:1700000000.000100"),
                status: choice("The task's new status. A task in Client review can't be changed here: its approver decides. CLIENT_REVIEW and DONE need all the task's subtasks Done first", STATUS_NAMES),
                priority: choice("The task's new priority. An incident's never changes, and a subtask has its task's: change the task's, and its subtasks follow", PRIORITY_NAMES),
                due_date: str('DD/MM/YYYY or YYYY-MM-DD, or "none" to remove the due date. Use a date the thread gives or clearly implies, never an invented one. An incident\'s never changes'),
                blocked: bool("true to mark the task blocked, false to unblock it. A blocked task keeps its status and shows as blocked on its card. Mark it only when the thread says it cannot go on until something else happens"),
                blocked_reason: str("Why it is blocked, in a short phrase of at most 100 characters (with blocked: true). Replaces the earlier reason"),
                prs: {
                    type: "object",
                    description: "Pull requests (GitHub, GitLab or Bitbucket) to link to and unlink from the task, as links. Adding gives suggested_message the request for its reviewers to review, while it is In review; only open ones can be unlinked, as merged and closed ones stay with the task. Cade reads no more of a repository than whether a GitHub pull request is open, merged or closed, so check one with your own tools first",
                    properties: {
                        add: strings("Pull requests to link to the task, as links"),
                        remove: strings("Pull requests to unlink from the task, as links")
                    },
                },
                ...Object.fromEntries(
                    Object.entries(ROLES).map(([role, label]) => [
                        role,
                        {
                            type: "object",
                            description: `Who to add to and remove from the task's ${label.toLowerCase()}s`,
                            properties: {
                                add: strings("Who to add, as Slack user IDs such as U0123ABCD"),
                                remove: strings("Who to remove, as Slack user IDs such as U0123ABCD")
                            },
                        },
                    ]),
                ),
            },
            required: ["task_id"],
        },
        outputSchema: outputWithNames({
            task_id: str("The task's ID, for the other tools"),
            changed: bool("Whether a field changed (and was posted in the thread)"),
            suggested_message: str("What the change asks of the people it names, not sent: offer it to the person for send_thread_message, mentions as <@ID>. Moved to Client review, the request to the approver instead, for send_approval_request's message. Empty when there's nothing to ask"),
        }),
    },
    {
        name: "send_approval_request",
        title: "Ask someone to approve a task",
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true},
        description:
            "Asks a person to approve a task that is in Client review: posts a request in the task's thread that mentions them, with Approve and Not approve buttons only they can click. Approving moves the task to Done; not approving sends it back to In progress. The request says \"<@approver>, could you take a look and approve it, or let us know what needs to change?\", then, on a line of its own, \"*PRs:* \" and the task's pull requests (get_task lists them), the same request the person starts with in Slack, unless they word it their own way in message, which replaces all of it, pull requests too: show it in the preview with their name, as \"@Cleo, could you take a look…\". Preview: the task, who will be asked to approve it, and the request as it will be posted. Call this only with an approver and request the person has chosen and approved. Each call posts a new request.",
        inputSchema: {
            type: "object",
            properties: {
                task_id: str("The task's ID, channel and message time joined by a colon, such as C0123ABCD:1700000000.000100"),
                approver: str("Who approves it, as a Slack user ID such as U0123ABCD: the client, or whoever handles them. find_user_by_name gives it"),
                message: str(`The request in the person's own words, as plain text, in place of the usual one, all of it. Mention people as <@U0123ABCD>; the approver is mentioned first when the message doesn't. A pull request is a link, <https://…|repo/42>. The usual one as update_task's suggested_message gives it, unchanged, is the same as leaving this out. At most ${MAX_MESSAGE} characters`),
            },
            required: ["task_id", "approver"],
        },
        outputSchema: outputWithNames({
            task_id: str("The task's ID, for the other tools"),
            approver: str("Who was asked: a Slack user ID, show the name, not the ID"),
            link: str("A link to the task's thread, or empty"),
        }),
    },
    {
        name: "get_prompts",
        title: "List the team's prompts",
        annotations: READS,
        description:
            "Lists this deployment's prompts: the team's own steps for kinds of work, such as a task's summary or a client report, each with what it is for and the arguments it takes. Read one with get_prompt.",
        inputSchema: {type: "object", properties: {}},
        outputSchema: outputOf({
            total: int("How many prompts the team has"),
            prompts: list("By name", {
                type: "object",
                description: "A prompt",
                properties: {
                    name: str("Its name, for get_prompt"),
                    description: str("When to use it and what it does"),
                    arguments: list("What it takes, for get_prompt's arguments", {
                        type: "object",
                        description: "An argument",
                        properties: {name: str("Its name"), description: str("What to give"), required: bool("Whether it must be given")},
                        required: ["name", "description", "required"],
                    }),
                },
                required: ["name", "description", "arguments"],
            }),
        }),
    },
    {
        name: "get_prompt",
        title: "Get one of the team's prompts",
        annotations: READS,
        description:
            "Gives one of this deployment's prompts, the team's own steps for a kind of work (get_prompts lists them), with the arguments you give after them: the same text the person gets by picking the prompt. A tool's result names the prompt for its work when the team has one. The tools a prompt names keep their own rules, approval included.",
        inputSchema: {
            type: "object",
            properties: {
                name: str("The prompt's name, such as task-summary"),
                arguments: {type: "object", description: "The prompt's arguments by name, such as {\"task\": \"C0123ABCD:1700000000.000100\"}", additionalProperties: {type: "string"}},
            },
            required: ["name"],
        },
        outputSchema: outputOf({
            name: str("The prompt's name"),
            description: str("What it is for"),
            text: str("Its steps, with the arguments given after them"),
        }),
    },
    {
        name: "get_server_info",
        title: "Get the version of the tools",
        annotations: READS,
        description:
            "Gives the version of Cade's tool set the server has now and the one this session loaded, and says whether the person should disconnect and connect Cade again to load the new tools.",
        inputSchema: {type: "object", properties: {}},
        outputSchema: outputOf({
            server_version: str("Cade's version"),
            toolset_version: str("The version of the tool set the server has now: it changes whenever a tool, a description or the instructions change"),
            session_toolset_version: str("The version of the tool set this session loaded when it connected, or empty if the client doesn't say"),
            status: choice("CURRENT: this session has the latest tools; OUTDATED: the person should disconnect and connect again; UNKNOWN: the client doesn't say which it loaded", SESSION_STATUSES),
        }),
    },
];

// Results and arguments are exact: an object lists every field it may have, and no others.
function strict<T>(schema: T): T {
    if (Array.isArray(schema)) return schema.map(strict) as T;
    if (!schema || typeof schema !== "object") return schema;
    const copy: Schema = Object.fromEntries(Object.entries(schema).map(([key, value]): [string, unknown] => [key, key === "properties" ? Object.fromEntries(Object.entries(value as Record<string, Schema>).map(([name, property]) => [name, strict(property)])) : strict(value)]));
    if (copy.properties && copy.additionalProperties === undefined) copy.additionalProperties = false;
    // A copy of `schema`, with additionalProperties added.
    return copy as T;
}

// Arguments are exact too: an argument a tool doesn't list is refused (see validate.ts), not ignored.
for (const tool of TOOL_DEFS) {
    tool.inputSchema = strict(tool.inputSchema);
    tool.outputSchema = strict(tool.outputSchema);
}
