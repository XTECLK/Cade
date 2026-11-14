// Made by `npm run docs` from the inputSchema of each tool in src/mcp-tools.ts: don't edit it by hand.
// Each tool's arguments, as its schema says and as they are once checked against it (see validate.ts).

export type GetTaskArgs = {
  // The task's ID, channel and message time joined by a colon, such as C0123ABCD:1700000000.000100
  task_id: string;
  // Only these fields, to keep the result small; task_id is always there. Default: all
  fields?: ("title" | "project" | "channel_id" | "status" | "priority" | "due_date" | "incident" | "blocked" | "blocked_reason" | "link" | "owner" | "reviewer" | "tester" | "parent" | "created_by" | "prs" | "completed_at" | "original_thread" | "original_thread_state" | "subtasks")[];
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
  // Only the messages after this one, by its ts (Slack's message time, such as 1700000000.000100). Default: every message
  since?: string;
};

export type GetTaskSummaryArgs = {
  // The task's ID, channel and message time joined by a colon, such as C0123ABCD:1700000000.000100
  task_id: string;
  // Leave out the saved summary and give every message of the task's thread. Default false
  full?: boolean;
};

export type SaveTaskSummaryArgs = {
  // The task's ID, channel and message time joined by a colon, such as C0123ABCD:1700000000.000100
  task_id: string;
  // The summary, as plain text. At most 8000 characters
  summary: string;
  // The last message of the task's thread it covers: the through get_task_summary gave
  through: string;
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
  // The fields to give for each task, besides task_id which is always there. Default: all but created_by, prs, completed_at
  fields?: ("title" | "project" | "channel_id" | "status" | "priority" | "due_date" | "incident" | "blocked" | "blocked_reason" | "link" | "owner" | "reviewer" | "tester" | "parent" | "created_by" | "prs" | "completed_at")[];
  // How many tasks to return, most urgent first. Default 20
  limit?: number;
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
  // Pull requests (GitHub, GitLab or Bitbucket) to link to and unlink from the task, as links. Adding gives suggested_message the request for its reviewers to review, while it is In review; only open ones can be unlinked, as merged and closed ones stay with the task. Cade reads no more of a repository than whether a GitHub pull request is open, merged or closed, so check one with your own tools first
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
  // The request in the person's own words, as plain text, in place of the usual one, all of it. Mention people as <@U0123ABCD>; the approver is mentioned first when the message doesn't. A pull request is a link, <https://…|repo/42>. The usual one as update_task's suggested_message gives it, unchanged, is the same as leaving this out. At most 3000 characters
  message?: string;
};

export type GetPromptsArgs = {

};

export type GetPromptArgs = {
  // The prompt's name, such as task-summary
  name: string;
  // The prompt's arguments by name, such as {"task": "C0123ABCD:1700000000.000100"}
  arguments?: Record<string, unknown>;
};

export type GetServerInfoArgs = {

};

// Each tool's arguments, by its name.
export interface ToolArgs {
  get_task: GetTaskArgs;
  get_thread_history: GetThreadHistoryArgs;
  get_task_history: GetTaskHistoryArgs;
  get_task_summary: GetTaskSummaryArgs;
  save_task_summary: SaveTaskSummaryArgs;
  get_tasks: GetTasksArgs;
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
  get_prompts: GetPromptsArgs;
  get_prompt: GetPromptArgs;
  get_server_info: GetServerInfoArgs;
}
