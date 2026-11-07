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
export const MAX_EARLIER_SUMMARIES = 10; // other summaries get_executive_summary lists
export const MAX_NAMES = 50; // people whose names a result carries

// How long a text can be, in characters.
export const MAX_TITLE = 150;
export const MAX_SUMMARY = 8000;
export const MAX_MESSAGE = 3000;
export const MAX_RELEASE_NOTE = 300;
export const MAX_PREVIEW = 300; // the start of a thread's first message
export const MAX_ITEM_TITLE = 200; // something a client call added
export const MAX_PROGRESS = 200;
export const MAX_ITEM_NOTES = 1000;
export const MAX_CALL_NOTES = 2000;

// How many entries a list can hold.
export const MAX_SUMMARY_ITEMS = 300;
export const MAX_ADDED_ITEMS = 50;

// ── Allowed values ───────────────────────────────────────────────────────────────────────────

// From tasks.ts.
const STATUS_NAMES = Object.keys(STATUSES);
const PRIORITY_NAMES = Object.keys(PRIORITIES);
const ROLE_NAMES = Object.keys(ROLES);

// A task's status in get_tasks: also open (everything not done) and all.
const TASK_STATUS_FILTER = ["open", "all", ...STATUS_NAMES];

// Releases and pull requests.
const RELEASE_STATUSES = ["PENDING_APPROVAL", "APPROVED", "NOT_APPROVED"];
const RELEASE_STATUS_FILTER = [...RELEASE_STATUSES, "all"];
const SENT_RELEASE_STATUSES = ["PENDING_APPROVAL", "APPROVED"]; // NOT_APPROVED ones are not kept
const PR_STATES = ["PENDING", "PENDING_APPROVAL", "APPROVED"];

// Whether a session has the latest tool set.
const SESSION_STATUSES = ["CURRENT", "OUTDATED", "UNKNOWN"];

// Where a task came from, and who is around.
const ORIGINAL_THREAD_STATES = ["found", "none", "unknown"];
const PRESENCES = ["active", "away", "unknown"];

// Executive summaries.
const HEALTHS = ["ON_TRACK", "AT_RISK", "DELAYED", "BLOCKED"];
const ITEM_KINDS = ["COMPLETED", "ACTIVE", "ADDED"];
const ITEM_CHANGES = ["pending", "unchanged", "changed", "removed", "added"];
const LINE_TYPES = ["heading", "paragraph", "item"];

// What get_users and find_user_by_name can give for each person, besides user_id.
export const USER_FIELDS = ["name", "username"];

// What get_availability and get_team_availability can give for each person, besides user_id.
export const AVAILABILITY_FIELDS = ["name", "open_tasks", "owner", "reviewer", "tester", "overdue", "urgent_or_high", "status", "status_until", "time_zone", "away", "presence"];

// ── Builders for a field ─────────────────────────────────────────────────────────────────────

// A JSON Schema, as the tools' inputSchema and outputSchema hold them.
export type Schema = { [key: string]: any };

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

// An executive summary's line for a task, as written and as agreed after the call.
const VERSION = {
    included: bool("Whether the summary mentions it"),
    health: choice("For active work", [...HEALTHS, null], {type: ["string", "null"]}),
    progress: str("Short free text, such as 3/5"),
    notes: str("One point per line"),
};

const THREAD = {
    type: ["object", "null"],
    description: "The thread a task was made from, or null",
    properties: {thread_id: str("The thread's ID, for get_thread_history"), link: str("A link to the thread")},
};

const MESSAGE_ITEM = {
    type: "object",
    description: "A message in a thread",
    properties: {
        ts: str("Slack's message time"),
        time: str("When it was sent (YYYY-MM-DD HH:MM, UTC)"),
        user_id: str("The sender: a Slack user ID (show the name, not the ID), a bot's name or ID, or unknown"),
        bot: bool("Whether a bot sent it"),
        text: str("What it says, with <@U…> mentions as sent"),
        files: strings("Names of attached files"),
    },
    required: ["ts", "time", "user_id", "bot", "text", "files"],
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
        state: choice("PENDING: not sent to the client yet; PENDING_APPROVAL: sent, waiting for the approver; APPROVED. A Done task's are all APPROVED", PR_STATES),
        release: {
            type: ["object", "null"],
            description: "The release it was sent with, or null while pending",
            properties: {
                release_id: int("The release's number"),
                note: str("What the release completes"),
                status: choice("PENDING_APPROVAL: waiting for the approver; APPROVED", SENT_RELEASE_STATUSES),
            },
        },
    },
    required: ["url", "label", "state", "release"],
};

// A property map: what get_tasks can include for each task, besides its task_id and the base fields.
export const EXTRA_FIELDS = {
    summary: str("The summary of the issue, or empty"),
    summary_by: str("Who wrote the summary, or empty: a Slack user ID, show the name, not the ID"),
    notes: str("The notes people wrote, or empty"),
    notes_link: str("A link to the notes page, or empty"),
    created_by: str("Who raised it: a Slack user ID, show the name, not the ID"),
    prs: list("The pull requests linked to the task, each with its state and the release it was sent with", PR_ITEM),
    completed_at: str("When it was marked Done, or empty (YYYY-MM-DD HH:MM, UTC)"),
};

const RELEASE_ITEM = {
    type: "object",
    description: "A partial release: pull requests sent to the client for approval before the whole task is done",
    properties: {
        release_id: int("The release's number"),
        prs: strings("The pull requests' addresses"),
        note: str("What the release completes"),
        status: choice("PENDING_APPROVAL: waiting for the approver; APPROVED; NOT_APPROVED: turned down, its PRs are pending again", RELEASE_STATUSES),
        sent_by: str("Who sent the release: a Slack user ID, show the name, not the ID"),
        sent_at: str("When it was sent (YYYY-MM-DD HH:MM, UTC)"),
        decided_by: str("Who decided it, or empty while waiting: a Slack user ID, show the name, not the ID"),
        decided_at: str("When it was decided, or empty (YYYY-MM-DD HH:MM, UTC)"),
    },
    required: ["release_id", "prs", "note", "status", "sent_by", "sent_at", "decided_by", "decided_at"],
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
        has_subtasks: bool("Whether it is done in parts, so Cade suggests no status changes from messages"),
        blocked: bool("Whether it is blocked: it keeps its status and shows as blocked on its card"),
        blocked_reason: str("Why it is blocked, in a short phrase, or empty"),
        link: str("A link to the task's message"),
        owner: strings("The task's owners, as Slack user IDs: show their names, not the IDs"),
        reviewer: strings("The task's reviewers, as Slack user IDs: show their names, not the IDs"),
        tester: strings("The task's testers, as Slack user IDs: show their names, not the IDs"),
    },
    required: ["task_id", "title", "status", "priority", "due_date", "incident", "link", "owner", "reviewer", "tester"],
};

export const TASK_FIELDS = [...Object.keys(TASK_ITEM.properties).filter((key) => key !== "task_id"), ...Object.keys(EXTRA_FIELDS)];
// get_task can also give where the task came from.
export const TASK_VIEW_FIELDS = [...TASK_FIELDS, "original_thread", "original_thread_state", "releases"];

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
            "Reads one task from Cade's own database: its details, people, links, summary and notes. It includes no thread, but names the one the task was made from, which get_thread_history reads.",
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
                notes_link: str("A link to the notes page, or empty"),
                summary: str("The summary of the issue, or empty"),
                summary_by: str("Who wrote the summary, or empty: a Slack user ID, show the name, not the ID"),
                notes: str("The notes people wrote, or empty"),
                original_thread_state: choice("found: original_thread names it; none: made from no other thread; unknown: no messages kept yet", ORIGINAL_THREAD_STATES),
                original_thread: THREAD,
                prs: list("The pull requests linked to the task, each with where it is and the release it was sent with", PR_ITEM),
                releases: list("The partial releases sent to the client for approval, oldest first (those not approved are not kept): which PRs, what they complete, who sent them and who approved", RELEASE_ITEM),
            },
        },
    },
    {
        name: "get_thread_history",
        title: "Read a Slack thread",
        annotations: READS_SLACK,
        description:
            "Reads a whole Slack thread from Slack, oldest message first. Slack's free plan hides messages older than 90 days; for a task Cade tracks, get_task_history has the messages Cade kept.",
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
            "Reads the messages Cade kept of a task's own thread, oldest first: what was done about the task. Unlike get_thread_history it doesn't ask Slack, so it still has messages Slack hides after 90 days.",
        inputSchema: {
            type: "object",
            properties: {
                task_id: str("The task's ID, channel and message time joined by a colon, such as C0123ABCD:1700000000.000100"),
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
        name: "get_tasks",
        title: "List tasks",
        annotations: READS,
        description:
            "Lists Cade tasks, most urgent first: your own or everyone's in the channels you can read, open ones by default. It can also give the tasks done in a period, with those not done, for an executive summary.",
        inputSchema: {
            type: "object",
            properties: {
                mine: bool("Only the tasks you are owner, reviewer or tester of"),
                role: choice("Only tasks where you have this role (implies mine)", ROLE_NAMES),
                assignee: str("Only tasks this person is on, as a Slack user ID such as U0123ABCD"),
                unassigned: bool("Only tasks nobody is owner, reviewer or tester of"),
                status: choice("open (default: everything not done), all, or one status", TASK_STATUS_FILTER),
                project: str("Only this project's tasks, by the name get_projects gives"),
                completed_from: str("Only tasks marked Done on or after this day (status defaults to DONE then) (YYYY-MM-DD)"),
                completed_to: str("Only tasks marked Done on or before this day (YYYY-MM-DD)"),
                include_open: bool("With completed_from or completed_to: give the tasks not done too, listed first, as well as those done in the days. Can't be combined with status"),
                fields: choices(`The fields to give for each task, besides task_id which is always there. Default: all but ${Object.keys(EXTRA_FIELDS).join(", ")}. Add summary or notes to get them for every task listed`, TASK_FIELDS),
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
        name: "get_releases",
        title: "List releases",
        annotations: READS,
        description:
            "Lists the partial releases of tasks: pull requests sent to the client for approval before the whole task is done. Approving or turning one down is the approver's click in Slack, not a tool.",
        inputSchema: {
            type: "object",
            properties: {
                status: choice("Default PENDING_APPROVAL", RELEASE_STATUS_FILTER),
                task_id: str("Only this task's releases"),
                project: str("Only this project's tasks, by the name get_projects gives"),
                limit: int(`How many releases to return, oldest first. Default ${DEFAULT_TASKS}`, {
                    minimum: 1,
                    maximum: MAX_TASKS
                }),
            },
        },
        outputSchema: outputWithNames({
            total: int("How many match and you can see"),
            releases: list("The releases that match, oldest first", {
                type: "object",
                description: "A release, with its task",
                properties: {
                    ...RELEASE_ITEM.properties,
                    task_id: str("The task's ID, for the other tools"),
                    title: str("The task's title"),
                    project: str("The project's name"),
                    prs: list("The release's pull requests", {
                        type: "object",
                        description: "A pull request in the release",
                        properties: {url: str("The pull request's address"), label: str("repo/number")},
                        required: ["url", "label"]
                    }),
                },
                required: [...RELEASE_ITEM.required, "task_id", "title", "project"],
            }),
        }),
    },
    {
        name: "update_release",
        title: "Change a release",
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true},
        description:
            "Changes a release still waiting for approval: its pull requests and what it completes. Cade updates the approver's request and the task's card, and tells the thread. It never approves or turns a release down: that is the approver's click in Slack. " +
            "Call this only with changes the person has seen and approved.",
        inputSchema: {
            type: "object",
            properties: {
                release_id: int("The release's number, as get_releases gives it", {minimum: 1}),
                prs: {
                    type: "object",
                    description: "Pull requests to add to and remove from the release, as links. Added ones must be linked to the task already (update_task prs.add) and not in another release; a release keeps at least one",
                    properties: {
                        add: strings("Pull requests to add to the release, as links"),
                        remove: strings("Pull requests to take out of the release, as links; they go back to pending")
                    },
                },
                note: str("What the release completes, replacing the earlier note", {maxLength: MAX_RELEASE_NOTE}),
            },
            required: ["release_id"],
        },
        outputSchema: outputWithNames({
            release_id: int("The release's number"),
            task_id: str("The task's ID, for the other tools"),
            changed: bool("Whether the release changed"),
            release: {...RELEASE_ITEM, description: "The release as it is now"},
        }),
    },
    {
        name: "get_channels",
        title: "List channels",
        annotations: READS_SLACK,
        description:
            "Lists the Slack channels Cade is in and you can read, project channels first. It is where to start to browse for conversations that should become tasks: pick a channel, then read its threads with get_channel_threads.",
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
            total: int("How many channels Cade is in that you can read"),
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
            "Creates a task, or an incident, in a project's channel as the person you act for: from a Slack thread (moved into the new task) or from scratch, with its summary saved on the notes page. An incident is always Urgent and due immediately. " +
            "Suggest the title, priority, due date and summary and ask for the person's input, and call this only with a task the person has seen and approved. Check with get_tasks that the task doesn't exist already. Each call makes a new task. Offer to assign people afterwards with update_task.",
        inputSchema: {
            type: "object",
            properties: {
                title: str("One short line saying what has to be done", {maxLength: MAX_TITLE}),
                project: str("The project to make it in, by the name get_projects gives. Can be left out when the thread is in a project's channel or there is only one project"),
                priority: choice("Default Medium. Not for an incident", PRIORITY_NAMES),
                due_date: str("DD/MM/YYYY or YYYY-MM-DD. Use a date the thread gives or clearly implies, never an invented one; leave out for none. Not for an incident"),
                incident: bool("Make an incident: only for something broken now that blocks people or the business, always Urgent and due immediately. When unsure, leave it false (a task). Default false"),
                summary: str(`The summary of the issue only, saved on the notes page: what the problem or request is, who raised it and when, the impact and the details needed to understand it, for someone who wasn't in the discussion. Write it from the thread it is made from, and leave out what that thread doesn't say. Plain text, people's names rather than @mentions. At most ${MAX_SUMMARY} characters`),
                thread_id: str("The thread to make it from. One that is already a task, was moved into one, or is a bot's or a direct message can't be used"),
                link: str("Instead of thread_id: a link to a message in the thread"),
            },
            required: ["title"],
        },
        outputSchema: outputOf({
            task_id: str("The task's ID, for the other tools"),
            link: str("A link to the task's message"),
            project: str("The project's name"),
            incident: bool("Whether it was made as an incident"),
            summary_saved: bool("Whether the summary was saved on the notes page"),
            notes_link: str("A link to the notes page, or empty"),
        }),
    },
    {
        name: "get_projects",
        title: "List projects",
        annotations: READS,
        description:
            "Lists the projects Cade tracks tasks for, in the channels you can read.",
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
                project: str("Count only this project's tasks, and cover only the people picked as working on it (everyone if none were picked). The project's name, as get_projects gives it"),
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
                project: str("Count only this project's tasks. If the project has people picked, the person must be one of them. The project's name, as get_projects gives it"),
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
            "Finds people in the Slack workspace by part of their name and gives each one's user ID, which update_task takes to assign someone and get_tasks takes as assignee.",
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
        name: "send_task_message",
        title: "Post in a task's thread",
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true},
        description:
            "Posts a message in a task's own thread in Slack as Cade, with a line under it saying who it is from. A mention notifies that person; @channel, @here and @everyone are not sent as mentions. " +
            "Call this only with text the person has seen and approved.",
        inputSchema: {
            type: "object",
            properties: {
                task_id: str("The task's ID, channel and message time joined by a colon, such as C0123ABCD:1700000000.000100"),
                text: str(`The message, as plain text, written as the person would. Mention a person as <@U0123ABCD>, with their user ID and never their name: only the ID notifies them, and a name written out notifies no one. The preview shows the name, but the call keeps the ID. At most ${MAX_MESSAGE} characters`),
                summary_id: int("An executive summary's number, as get_executive_summary gives it. Give it when the message tells the thread what a client call decided (see update_executive_summary_after_call): Cade then marks the task as told, and refuses to send if it was told already", {minimum: 1}),
            },
            required: ["task_id", "text"],
        },
        outputSchema: outputOf({
            task_id: str("The task's ID, for the other tools"),
            sent: bool("Whether the message was posted"),
            link: str("A link to the task's thread, or empty")
        }),
    },
    {
        name: "update_task",
        title: "Update a task",
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true},
        description:
            "Changes a task in one call: its status, priority, due date, people, pull requests and the summary on its notes page. Cade posts the field changes in the task's thread and asks the people it assigns to pick it up; the summary is saved quietly. " +
            "Call this only with changes the person has seen and approved.",
        inputSchema: {
            type: "object",
            properties: {
                task_id: str("The task's ID, channel and message time joined by a colon, such as C0123ABCD:1700000000.000100"),
                status: choice("The task's new status. A task in Client review can't be changed here: its approver decides", STATUS_NAMES),
                priority: choice("The task's new priority. An incident's never changes", PRIORITY_NAMES),
                due_date: str('DD/MM/YYYY or YYYY-MM-DD, or "none" to remove the due date. Use a date the thread gives or clearly implies, never an invented one. An incident\'s never changes'),
                blocked: bool("true to mark the task blocked, false to unblock it. A blocked task keeps its status and shows as blocked on its card. Mark it only when the thread says it cannot go on until something else happens"),
                blocked_reason: str("Why it is blocked, in a short phrase of at most 100 characters (with blocked: true). Replaces the earlier reason"),
                has_subtasks: bool("true when the task is done in parts (subtasks): Cade then suggests no status changes from people's messages, and the status is set by hand. Pull requests are still tracked"),
                summary: str(`The summary of the task's issue only: what the problem or request is, who raised it and when, the impact and the details needed to understand it, for someone who wasn't in the discussion. Write it from the thread the task was made from (get_task names it; if there is none, from the task's own thread), and leave out what that thread doesn't say, and what was done and how it ended. Plain text, short paragraphs, "- " for bullets, people's names rather than @mentions. At most ${MAX_SUMMARY} characters. Replaces any earlier one`),
                prs: {
                    type: "object",
                    description: "Pull requests (GitHub, GitLab or Bitbucket) to link to and unlink from the task, as links. Adding asks the task's reviewers to review; one already sent to the client for approval can't be unlinked here. Cade can't see repositories, so check a pull request with your own tools first",
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
        outputSchema: outputOf({
            task_id: str("The task's ID, for the other tools"),
            changed: bool("Whether a field changed (and was posted in the thread)"),
            summary_saved: bool("Whether the summary was saved on the notes page"),
            notes_link: str("A link to the notes page, or empty"),
        }),
    },
    {
        name: "send_approval_request",
        title: "Ask someone to approve a task",
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true},
        description:
            "Asks a person to approve a task that is in Client review: posts a request in the task's thread that mentions them, with Approve and Not approve buttons only they can click. Approving moves the task to Done; not approving sends it back to In progress. Call this only with an approver the person has chosen and approved. Each call posts a new request.",
        inputSchema: {
            type: "object",
            properties: {
                task_id: str("The task's ID, channel and message time joined by a colon, such as C0123ABCD:1700000000.000100"),
                approver: str("Who approves it, as a Slack user ID such as U0123ABCD: the client, or whoever handles them. find_user_by_name gives it"),
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
    {
        name: "get_executive_summary",
        title: "Read an executive summary",
        annotations: READS,
        description:
            "Reads an executive summary Cade kept of a project: what it said of each task as written and as agreed after the client call, and whether each task's thread has been told. It is where to start to write the next summary: its period ends where the next begins, and get_tasks (completed_from, completed_to, include_open) gives the tasks to cover.",
        inputSchema: {
            type: "object",
            properties: {
                project: str("The project, by the name get_projects gives"),
                date: str("The summary in force on that day. Default: the last one (YYYY-MM-DD)"),
            },
            required: ["project"],
        },
        outputSchema: outputWithNames({
            project: str("The project's name"),
            summary: {
                type: ["object", "null"],
                description: "The summary, or null if the project has none yet",
                properties: {
                    summary_id: int("For get_executive_summary_doc and update_executive_summary_after_call"),
                    created_at: str("When it was written (YYYY-MM-DD HH:MM, UTC)"),
                    created_by: str("Who wrote the summary: a Slack user ID, show the name, not the ID"),
                    from: str("First day of its period (YYYY-MM-DD)"),
                    to: str("Last day of its period (YYYY-MM-DD)"),
                    doc_url: str("Where it is in the Google Doc"),
                    call: {
                        type: ["object", "null"],
                        description: "What was said of the call as a whole, or null until it was recorded",
                        properties: {
                            notes: str("What was said of the call"),
                            recorded_by: str("Who recorded the call: a Slack user ID, show the name, not the ID"),
                            recorded_at: str("When it was recorded (YYYY-MM-DD HH:MM, UTC)")
                        }
                    },
                    items: list("Each task with the summary as written (before) and as agreed after the call (after)", {
                        type: "object",
                        description: "A task's line in the summary",
                        properties: {
                            task_id: str("Empty for something added in the call that has no task"),
                            title: str("The task's title when it was written"),
                            status: str("Its status when it was written"),
                            incident: bool("Whether the task is an incident"),
                            kind: choice("COMPLETED: done in the period; ACTIVE: not done; ADDED: added in the call", ITEM_KINDS),
                            before: {
                                type: ["object", "null"],
                                description: "As written; null for what the call added",
                                properties: VERSION
                            },
                            after: {
                                type: ["object", "null"],
                                description: "As agreed after the call; null until the call is recorded",
                                properties: VERSION
                            },
                            change: choice("pending: no call recorded yet", ITEM_CHANGES),
                            informed_at: str("When the task's thread was told about this change, or empty. Tell it only if this is empty (YYYY-MM-DD HH:MM, UTC)"),
                        },
                        required: ["task_id", "title", "status", "incident", "kind", "before", "after", "change", "informed_at"],
                    }),
                },
            },
            earlier: list(`The project's other summaries, newest first (at most ${MAX_EARLIER_SUMMARIES})`, {
                type: "object",
                description: "Another summary of the project",
                properties: {
                    summary_id: int("The executive summary's number"),
                    created_at: str("When it was written (YYYY-MM-DD HH:MM, UTC)"),
                    from: str("A day, YYYY-MM-DD"),
                    to: str("A day, YYYY-MM-DD")
                },
                required: ["summary_id", "created_at", "from", "to"]
            }),
        }),
    },
    {
        name: "get_executive_summary_doc",
        title: "Read an executive summary from its Google Doc",
        annotations: READS_SLACK,
        description:
            "Reads a summary's section from the project's Google Doc as it reads now, after people edited it, such as in the client call. Compare it with get_executive_summary to find what the call changed, then record it with update_executive_summary_after_call.",
        inputSchema: {
            type: "object",
            properties: {
                project: str("The project, by the name get_projects gives"),
                summary_id: int("The summary, as get_executive_summary gives it. Default: the last one", {minimum: 1}),
            },
            required: ["project"],
        },
        outputSchema: outputOf({
            project: str("The project's name"),
            summary_id: int("The executive summary's number"),
            doc_url: str("Where it is in the Google Doc"),
            lines: list("The section's lines, in order", {
                type: "object",
                description: "A line of the section",
                properties: {
                    type: choice("What kind of line it is", LINE_TYPES),
                    level: int("How deeply it is nested, 0 for the top"),
                    text: str("The line's text"),
                    task_id: str("The task the line links to, or empty"),
                    written: bool("Whether Cade wrote this line (false: people added it)")
                },
                required: ["type", "level", "text", "task_id", "written"],
            }),
        }),
    },
    {
        name: "create_executive_summary",
        title: "Write an executive summary to the Google Doc",
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true},
        description:
            "Writes an executive summary to the top of the project's Google Doc (its Summary tab) and keeps what it says of each task. Each call writes a new one. " +
            "Call this only with a summary the person has seen and approved.",
        inputSchema: {
            type: "object",
            properties: {
                project: str("The project, by the name get_projects gives"),
                from: str("First day of the period (YYYY-MM-DD). Default: the day after the last summary's period, or 7 days ago if there is none"),
                to: str("Last day of the period (YYYY-MM-DD). Default: today"),
                items: list("A line for each task the person said something about. A task not listed keeps what the last summary said (an active one with none is ON_TRACK) and completed ones are included; the result names the active ones it carried over. Only tasks of the project completed in the period or not done can be listed", {
                    type: "object",
                    description: "A task's line in the summary",
                    properties: {
                        task_id: str("The task's ID, channel and message time joined by a colon, such as C0123ABCD:1700000000.000100"),
                        included: bool("Whether the summary mentions it. Default true"),
                        health: choice("ON_TRACK, AT_RISK, DELAYED or BLOCKED, for work not done. Judge it from what the tasks and threads show, never guess", HEALTHS),
                        progress: str("Short free text, such as 3/5 or 2 of 4 CRMs live, from what the tasks show", {maxLength: MAX_PROGRESS}),
                        notes: str("One point per line", {maxLength: MAX_ITEM_NOTES}),
                    },
                    required: ["task_id"],
                }, {maxItems: MAX_SUMMARY_ITEMS}),
            },
            required: ["project"],
        },
        outputSchema: outputOf({
            project: str("The project's name"),
            summary_id: int("For get_executive_summary_doc and update_executive_summary_after_call"),
            from: str("A day, YYYY-MM-DD"),
            to: str("A day, YYYY-MM-DD"),
            doc_url: str("Where it is in the Google Doc"),
            carried_over: strings("Task IDs of the active tasks you didn't list, which kept what the last summary said"),
        }),
    },
    {
        name: "update_executive_summary_after_call",
        title: "Record what the client call decided",
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false},
        description:
            "Records the summary as it was agreed in the client call, next to the summary as it was written, so both are kept and can be compared. It posts nothing and changes no task or Google Doc. After it, tell each changed task's thread with send_task_message (summary_id), and offer create_task, one at a time, for what the call added. " +
            "Call this only with what the person has seen and approved.",
        inputSchema: {
            type: "object",
            properties: {
                summary_id: int("The summary, as get_executive_summary gives it", {minimum: 1}),
                items: list("The tasks whose health, progress, notes or inclusion the call changed (included false takes one out). The after version starts as the written one. Recording again replaces the earlier recording, but a task whose thread was told keeps that unless it changed again", {
                    type: "object",
                    description: "A task whose line the call changed",
                    properties: {
                        task_id: str("The task's ID, channel and message time joined by a colon, such as C0123ABCD:1700000000.000100"),
                        included: bool("Whether the summary mentions it"),
                        health: choice("ON_TRACK, AT_RISK, DELAYED or BLOCKED, for work not done. Judge it from what the tasks and threads show, never guess", HEALTHS),
                        progress: str("Short free text, such as 3/5 or 2 of 4 CRMs live, from what the tasks show", {maxLength: MAX_PROGRESS}),
                        notes: str("One point per line", {maxLength: MAX_ITEM_NOTES})
                    },
                    required: ["task_id"],
                }, {maxItems: MAX_SUMMARY_ITEMS}),
                added: list("What the call added: a title for each, with task_id if it is already a task", {
                    type: "object",
                    description: "Something the call added",
                    properties: {
                        title: str("What was added", {maxLength: MAX_ITEM_TITLE}),
                        task_id: str("The task's ID, channel and message time joined by a colon, such as C0123ABCD:1700000000.000100"),
                        health: choice("ON_TRACK, AT_RISK, DELAYED or BLOCKED, for work not done. Judge it from what the tasks and threads show, never guess", HEALTHS),
                        progress: str("Short free text, such as 3/5 or 2 of 4 CRMs live, from what the tasks show", {maxLength: MAX_PROGRESS}),
                        notes: str("One point per line", {maxLength: MAX_ITEM_NOTES})
                    },
                    required: ["title"],
                }, {maxItems: MAX_ADDED_ITEMS}),
                notes: str("Anything about the call as a whole", {maxLength: MAX_CALL_NOTES}),
            },
            required: ["summary_id"],
        },
        outputSchema: outputOf({
            summary_id: int("The executive summary's number"),
            changed: strings("Task IDs whose summary line the call changed or took out"),
            added: int("How many items the call added")
        }),
    },
];

// Results and arguments are exact: an object lists every field it may have, and no others.
function strict(schema: any): any {
    if (Array.isArray(schema)) return schema.map(strict);
    if (!schema || typeof schema !== "object") return schema;
    const copy: Schema = Object.fromEntries(Object.entries(schema).map(([key, value]): [string, any] => [key, key === "properties" ? Object.fromEntries(Object.entries(value as Schema).map(([name, property]) => [name, strict(property)])) : strict(value)]));
    if (copy.properties && copy.additionalProperties === undefined) copy.additionalProperties = false;
    return copy;
}

// Arguments are exact too: an argument a tool doesn't list is refused (see validate.ts), not ignored.
for (const tool of TOOL_DEFS) {
    tool.inputSchema = strict(tool.inputSchema);
    tool.outputSchema = strict(tool.outputSchema);
}
