// Made by `npm run docs` from the inputSchema of each tool in src/mcp-tools.ts: don't edit it by hand.
// Each tool's arguments, as its schema says and as they are once checked against it (see validate.ts).

export type GetTaskArgs = {
  // The task's ID, channel and message time joined by a colon, such as C0123ABCD:1700000000.000100
  task_id: string;
  // Only these fields, to keep the result small; task_id is always there. Default: all
  fields?: ("title" | "project" | "channel_id" | "status" | "priority" | "due_date" | "incident" | "has_subtasks" | "blocked" | "blocked_reason" | "link" | "owner" | "reviewer" | "tester" | "parent" | "summary" | "summary_by" | "notes" | "notes_link" | "created_by" | "prs" | "completed_at" | "original_thread" | "original_thread_state" | "releases" | "subtasks")[];
};

export type GetThreadHistoryArgs = {
  // The thread's ID, channel and message time joined by a colon, such as C0123ABCD:1700000000.000100
  thread_id?: string;
  // Instead of thread_id: a link to a message in the thread, such as https://team.slack.com/archives/C0123ABCD/p1700000000123456
  link?: string;
};

export type GetTaskHistoryArgs = {
  // The task's ID, channel and message time joined by a colon, such as C0123ABCD:1700000000.000100
  task_id: string;
};

export type GetTasksArgs = {
  // Only tasks one of these people is on, in one of roles. "me" is you, so ["me"] gives your own tasks
  assignees?: string[];
  // With assignees: only the tasks where one of them has one of these roles. Default: all three
  roles?: ("owner" | "reviewer" | "tester")[];
  // Only tasks nobody is owner, reviewer or tester of. Can't be combined with assignees
  unassigned?: boolean;
  // open (default: everything not done), all, or one status
  status?: "open" | "all" | "TODO" | "IN_PROGRESS" | "IN_REVIEW" | "IN_TESTING" | "CLIENT_REVIEW" | "DONE";
  // Only this project's tasks, by the name get_projects gives
  project?: string;
  // Only tasks marked Done on or after this day (status defaults to DONE then) (YYYY-MM-DD)
  completed_from?: string;
  // Only tasks marked Done on or before this day (YYYY-MM-DD)
  completed_to?: string;
  // With completed_from or completed_to: give the tasks not done too, listed first, as well as those done in the days. Can't be combined with status
  include_open?: boolean;
  // The fields to give for each task, besides task_id which is always there. Default: all but summary, summary_by, notes, notes_link, created_by, prs, completed_at. Add summary or notes to get them for every task listed
  fields?: ("title" | "project" | "channel_id" | "status" | "priority" | "due_date" | "incident" | "has_subtasks" | "blocked" | "blocked_reason" | "link" | "owner" | "reviewer" | "tester" | "parent" | "summary" | "summary_by" | "notes" | "notes_link" | "created_by" | "prs" | "completed_at")[];
  // How many tasks to return, most urgent first. Default 20
  limit?: number;
};

export type GetReleasesArgs = {
  // Default PENDING_APPROVAL
  status?: "PENDING_APPROVAL" | "APPROVED" | "NOT_APPROVED" | "all";
  // Only this task's releases
  task_id?: string;
  // Only this project's tasks, by the name get_projects gives
  project?: string;
  // How many releases to return, oldest first. Default 20
  limit?: number;
};

export type UpdateReleaseArgs = {
  // The release's number, as get_releases gives it
  release_id: number;
  // Pull requests to add to and remove from the release, as links. Added ones must be linked to the task already (update_task prs.add) and not in another release; a release keeps at least one
  prs?: {
    // Pull requests to add to the release, as links
    add?: string[];
    // Pull requests to take out of the release, as links; they go back to pending
    remove?: string[];
  };
  // What the release completes, replacing the earlier note
  note?: string;
};

export type GetChannelsArgs = {
  // How many channels to return. Default 50
  limit?: number;
};

export type GetChannelThreadsArgs = {
  // The channel's ID, as get_channels gives it, such as C0123ABCD
  channel_id: string;
  // How many days back to look. Default 14
  days?: number;
  // Only the messages that have replies, the conversations that happened. Default false: every message of people
  with_replies?: boolean;
  // How many threads to return, newest first. Default 10
  limit?: number;
};

export type CreateTaskArgs = {
  // One short line saying what has to be done
  title: string;
  // The project to make it in, by the name get_projects gives. Can be left out when the thread is in a project's channel or there is only one project
  project?: string;
  // Default Medium. Not for an incident
  priority?: "Urgent" | "High" | "Medium" | "Low";
  // DD/MM/YYYY or YYYY-MM-DD. Use a date the thread gives or clearly implies, never an invented one; leave out for none. Not for an incident
  due_date?: string;
  // Make an incident: only for something broken now that blocks people or the business, always Urgent and due immediately. When unsure, leave it false (a task). Default false
  incident?: boolean;
  // The summary of the issue only, saved on the notes page: what the problem or request is, who raised it and when, the impact and the details needed to understand it, for someone who wasn't in the discussion. Write it from the thread it is made from, and leave out what that thread doesn't say. Plain text, people's names rather than @mentions. At most 8000 characters
  summary?: string;
  // The thread to make it from. One that is already a task, was moved into one, or is a bot's or a direct message can't be used
  thread_id?: string;
  // Instead of thread_id: a link to a message in the thread
  link?: string;
  // Make it a subtask of this task, by the ID get_tasks gives. Leave out project and priority (it has the task's); due_date defaults to the task's
  parent_task_id?: string;
};

export type GetProjectsArgs = {

};

export type GetUserArgs = {
  // A Slack user ID such as U0123ABCD, or a <@…> mention
  user_id: string;
  // Also give their email, phone number and title. Private: ask for it only when needed, such as to reach someone on WhatsApp (https://wa.me/<number with country code, digits only>?text=<URL-encoded message> opens the chat). Default false
  profile?: boolean;
};

export type GetUsersArgs = {
  // How many people to return. Default 50
  limit?: number;
  // Only these fields for each person, to keep the result small; user_id is always there. Default: all
  fields?: ("name" | "username")[];
};

export type GetTeamAvailabilityArgs = {
  // Only these people, as Slack user IDs such as U0123ABCD
  users?: string[];
  // Count only this project's tasks, and cover only the people in its channel. The project's name, as get_projects gives it
  project?: string;
  // The fields to give, to keep the result small; user_id is always there. Default: all but presence. Add presence to look up whether the person is active in Slack right now (one Slack call each)
  fields?: ("name" | "open_tasks" | "owner" | "reviewer" | "tester" | "overdue" | "urgent_or_high" | "status" | "status_until" | "time_zone" | "away" | "presence")[];
  // How many people to return, least loaded first. Default 50
  limit?: number;
};

export type GetAvailabilityArgs = {
  // The person, as a Slack user ID such as U0123ABCD
  user_id: string;
  // Count only this project's tasks; the person must be in its channel. The project's name, as get_projects gives it
  project?: string;
  // The fields to give, to keep the result small; user_id is always there. Default: all but presence. Add presence to look up whether the person is active in Slack right now (one Slack call each)
  fields?: ("name" | "open_tasks" | "owner" | "reviewer" | "tester" | "overdue" | "urgent_or_high" | "status" | "status_until" | "time_zone" | "away" | "presence")[];
};

export type FindUserByNameArgs = {
  // Part of the person's name, such as Ann or ann.lee
  name: string;
  // Only these fields for each person, to keep the result small; user_id is always there. Default: all
  fields?: ("name" | "username")[];
};

export type SendThreadMessageArgs = {
  // The thread's ID, channel and message time joined by a colon, such as C0123ABCD:1700000000.000100. A task's ID is its thread's
  thread_id?: string;
  // Instead of thread_id: a link to a message in the thread, such as https://team.slack.com/archives/C0123ABCD/p1700000000123456
  link?: string;
  // The message, as plain text, written as the person would. Mention a person as <@U0123ABCD>, with their user ID and never their name: only the ID notifies them, and a name written out notifies no one. The preview shows the name, but the call keeps the ID. At most 3000 characters
  text: string;
  // An executive summary's number, as get_executive_summary gives it. Give it when the message tells the thread what a client call decided (see update_executive_summary_after_call): Cade then marks the task as told, and refuses to send if it was told already. Only for a task's thread
  summary_id?: number;
};

export type UpdateTaskArgs = {
  // The task's ID, channel and message time joined by a colon, such as C0123ABCD:1700000000.000100
  task_id: string;
  // The task's new status. A task in Client review can't be changed here: its approver decides. CLIENT_REVIEW and DONE need all the task's subtasks Done first
  status?: "TODO" | "IN_PROGRESS" | "IN_REVIEW" | "IN_TESTING" | "CLIENT_REVIEW" | "DONE";
  // The task's new priority. An incident's never changes, and a subtask has its task's: change the task's, and its subtasks follow
  priority?: "Urgent" | "High" | "Medium" | "Low";
  // DD/MM/YYYY or YYYY-MM-DD, or "none" to remove the due date. Use a date the thread gives or clearly implies, never an invented one. An incident's never changes
  due_date?: string;
  // true to mark the task blocked, false to unblock it. A blocked task keeps its status and shows as blocked on its card. Mark it only when the thread says it cannot go on until something else happens
  blocked?: boolean;
  // Why it is blocked, in a short phrase of at most 100 characters (with blocked: true). Replaces the earlier reason
  blocked_reason?: string;
  // true when the task is done in parts (subtasks): Cade then suggests no status changes from people's messages, and the status is set by hand. Pull requests are still tracked
  has_subtasks?: boolean;
  // The summary of the task's issue only: what the problem or request is, who raised it and when, the impact and the details needed to understand it, for someone who wasn't in the discussion. Write it from the thread the task was made from (get_task names it; if there is none, from the task's own thread), and leave out what that thread doesn't say, and what was done and how it ended. Plain text, short paragraphs, "- " for bullets, people's names rather than @mentions. At most 8000 characters. Replaces any earlier one
  summary?: string;
  // Pull requests (GitHub, GitLab or Bitbucket) to link to and unlink from the task, as links. Adding asks the task's reviewers to review; one already sent to the client for approval can't be unlinked here. Cade can't see repositories, so check a pull request with your own tools first
  prs?: {
    // Pull requests to link to the task, as links
    add?: string[];
    // Pull requests to unlink from the task, as links
    remove?: string[];
  };
  // Who to add to and remove from the task's owners
  owner?: {
    // Who to add, as Slack user IDs such as U0123ABCD
    add?: string[];
    // Who to remove, as Slack user IDs such as U0123ABCD
    remove?: string[];
  };
  // Who to add to and remove from the task's reviewers
  reviewer?: {
    // Who to add, as Slack user IDs such as U0123ABCD
    add?: string[];
    // Who to remove, as Slack user IDs such as U0123ABCD
    remove?: string[];
  };
  // Who to add to and remove from the task's testers
  tester?: {
    // Who to add, as Slack user IDs such as U0123ABCD
    add?: string[];
    // Who to remove, as Slack user IDs such as U0123ABCD
    remove?: string[];
  };
};

export type SendApprovalRequestArgs = {
  // The task's ID, channel and message time joined by a colon, such as C0123ABCD:1700000000.000100
  task_id: string;
  // Who approves it, as a Slack user ID such as U0123ABCD: the client, or whoever handles them. find_user_by_name gives it
  approver: string;
};

export type GetServerInfoArgs = {

};

export type GetExecutiveSummaryArgs = {
  // The project, by the name get_projects gives
  project: string;
  // The summary in force on that day. Default: the last one (YYYY-MM-DD)
  date?: string;
};

export type GetExecutiveSummaryDocArgs = {
  // The project, by the name get_projects gives
  project: string;
  // The summary, as get_executive_summary gives it. Default: the last one
  summary_id?: number;
};

export type CreateExecutiveSummaryArgs = {
  // The project, by the name get_projects gives
  project: string;
  // First day of the period (YYYY-MM-DD). Default: the day after the last summary's period, or 7 days ago if there is none
  from?: string;
  // Last day of the period (YYYY-MM-DD). Default: today
  to?: string;
  // A line for each task the person said something about. A task not listed keeps what the last summary said (an active one with none is ON_TRACK) and completed ones are included; the result names the active ones it carried over. Only tasks of the project completed in the period or not done can be listed
  items?: {
    // The task's ID, channel and message time joined by a colon, such as C0123ABCD:1700000000.000100
    task_id: string;
    // Whether the summary mentions it. Default true
    included?: boolean;
    // ON_TRACK, AT_RISK, DELAYED or BLOCKED, for work not done. Judge it from what the tasks and threads show, never guess
    health?: "ON_TRACK" | "AT_RISK" | "DELAYED" | "BLOCKED";
    // Short free text, such as 3/5 or 2 of 4 CRMs live, from what the tasks show
    progress?: string;
    // One point per line
    notes?: string;
  }[];
};

export type UpdateExecutiveSummaryAfterCallArgs = {
  // The summary, as get_executive_summary gives it
  summary_id: number;
  // The tasks whose health, progress, notes or inclusion the call changed (included false takes one out). The after version starts as the written one. Recording again replaces the earlier recording, but a task whose thread was told keeps that unless it changed again
  items?: {
    // The task's ID, channel and message time joined by a colon, such as C0123ABCD:1700000000.000100
    task_id: string;
    // Whether the summary mentions it
    included?: boolean;
    // ON_TRACK, AT_RISK, DELAYED or BLOCKED, for work not done. Judge it from what the tasks and threads show, never guess
    health?: "ON_TRACK" | "AT_RISK" | "DELAYED" | "BLOCKED";
    // Short free text, such as 3/5 or 2 of 4 CRMs live, from what the tasks show
    progress?: string;
    // One point per line
    notes?: string;
  }[];
  // What the call added: a title for each, with task_id if it is already a task
  added?: {
    // What was added
    title: string;
    // The task's ID, channel and message time joined by a colon, such as C0123ABCD:1700000000.000100
    task_id?: string;
    // ON_TRACK, AT_RISK, DELAYED or BLOCKED, for work not done. Judge it from what the tasks and threads show, never guess
    health?: "ON_TRACK" | "AT_RISK" | "DELAYED" | "BLOCKED";
    // Short free text, such as 3/5 or 2 of 4 CRMs live, from what the tasks show
    progress?: string;
    // One point per line
    notes?: string;
  }[];
  // Anything about the call as a whole
  notes?: string;
};

// Each tool's arguments, by its name.
export interface ToolArgs {
  get_task: GetTaskArgs;
  get_thread_history: GetThreadHistoryArgs;
  get_task_history: GetTaskHistoryArgs;
  get_tasks: GetTasksArgs;
  get_releases: GetReleasesArgs;
  update_release: UpdateReleaseArgs;
  get_channels: GetChannelsArgs;
  get_channel_threads: GetChannelThreadsArgs;
  create_task: CreateTaskArgs;
  get_projects: GetProjectsArgs;
  get_user: GetUserArgs;
  get_users: GetUsersArgs;
  get_team_availability: GetTeamAvailabilityArgs;
  get_availability: GetAvailabilityArgs;
  find_user_by_name: FindUserByNameArgs;
  send_thread_message: SendThreadMessageArgs;
  update_task: UpdateTaskArgs;
  send_approval_request: SendApprovalRequestArgs;
  get_server_info: GetServerInfoArgs;
  get_executive_summary: GetExecutiveSummaryArgs;
  get_executive_summary_doc: GetExecutiveSummaryDocArgs;
  create_executive_summary: CreateExecutiveSummaryArgs;
  update_executive_summary_after_call: UpdateExecutiveSummaryAfterCallArgs;
}
