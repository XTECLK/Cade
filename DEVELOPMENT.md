# Development

How Cade is built, and how to work on it. To set it up for your team, see [GETTING_STARTED.md](GETTING_STARTED.md); to contribute, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Start developing

Cade is a Slack app on a Cloudflare Worker, and Slack can only call a public address, so the easiest way to develop it is against
a real, **separate** copy of its own: your own Cloudflare account, a Slack workspace of your own, and the setup script to join
them. Both are free.

### 1. Get your own accounts

- A **Cloudflare account** (the free plan is enough).
- A **Slack workspace** just for development: create one at <https://slack.com/create>. Don't develop in your team's real
  workspace; the app you make will post and create channels there.
- Node.js 22.18 or newer (it runs TypeScript directly, which the tests and scripts rely on), and git.

### 2. Set it up with the guided script

```sh
git clone https://github.com/XTECLK/Cade.git   # or your fork
cd Cade
npm install
npm run check       # the type check, then the whole suite, in a few seconds, without Slack
npm run setup       # Cloudflare login, the Worker, the Slack app, your first group
```

`npm run setup` deploys the Worker, creates the Slack app from `slack/manifest.json`, and asks for the first admin. The Worker is named `cade`, so use a Cloudflare account of its own for development. The Google Doc step is optional; skip
it unless you're working on the executive summary tools. Then create a channel, invite Cade with `/invite @Cade`, and add it as a project from the app's Home tab.
[GETTING_STARTED.md](GETTING_STARTED.md) has every step by hand.

When you work in this repo, your settings (`cade.config.json`, `.cade/`) stay in it, ignored by git. A team's real deployment keeps them in its own repo, made from the [cade-deploy](https://github.com/XTECLK/cade-deploy) template, which sets `CADE_DEPLOY_DIR` to point the scripts there (see `scripts/paths.ts`).

### 3. Change, deploy, try

```sh
npm run check       # after each change: the type check and the tests
npm run deploy      # puts your change on your Worker, and applies new migrations
```

The code is TypeScript, with no build step of its own: wrangler bundles `src/` when it deploys, and Node runs
the tests and scripts by stripping the types. `npm run typecheck` (`tsc`) is what checks them, and `npm run check`
runs it before the tests. Only syntax that strips away is used (no `enum` or `namespace`; `tsconfig.json` enforces
it), and imports name the `.ts` file. The shapes the modules share (a task, a release, a command, Slack's payloads,
a handler) are in `src/types.ts`; D1's rows are in `src/db.ts`; the Worker's bindings and settings in `src/env.ts`.
After changing `wrangler.toml`, run `npm run types` to regenerate `worker-configuration.d.ts`.

For a change that shouldn't change what the Worker does, such as a refactor or new types, `npm run bundle-diff`
(or `npm run bundle-diff -- <ref>`) builds the Worker as wrangler deploys it, now and at the last commit (or the
ref), and says whether its code is the same, ignoring formatting, comments and file extensions. The same code means
nothing changed, whether the tests cover it or not.

JSON that comes back in is checked against a JSON Schema at runtime (`src/validate.ts`, with
`@cfworker/json-schema`, pinned to an exact version):

- An MCP tool's arguments are checked against its `inputSchema` before it runs. An argument it doesn't list, a wrong
  type or a value out of range is refused, saying which, so the agent can correct it. Add a tool's arguments to its
  `inputSchema` in `src/mcp-tools.ts`: the schema the agent is shown is the one enforced.
- What Cade puts in its own buttons and forms (a button's value, a `block_id`, a form's `private_metadata`) is read
  with `readPayload` against its schema in `src/payloads.ts`. A message stays in Slack for good, so a button can come
  back from a message an older Cade posted: one that no longer fits is answered with a private "out of date" note
  instead of failing (see `handleInteraction` in `src/index.ts`). A schema asks only for what its reader uses, so older
  messages that still work keep working. When you change what a button carries, change its schema with it.
- What Slack sends (events, interactions, slash commands) is checked once its signature is, in `src/envelopes.ts`,
  for only the fields Cade routes it by: one that can't be read is answered 400 and logged ("Slack sent something
  Cade can't read"), not failed on halfway through a handler. Anything else Slack adds or leaves out never matters.
- `cade.config.json` is checked by `npm run config` before anything is uploaded: first the checks in
  `scripts/config.ts` for the common mistakes, which say how to fix them, then its schema in `src/config-schema.ts`
  for everything else, so a misspelt or retired setting is refused rather than uploaded to do nothing. A new setting
  goes in both the schema and `readConfig`.

Then use it in Slack. A deploy takes a few seconds. Changes to the Slack app itself (commands, scopes, events) go in
`slack/manifest.json`, and `npm run slack:update` applies them.

### 4. Debug with the live logs, and an AI agent

Watch what the Worker does while you use it:

```sh
node scripts/wrangler.ts tail      # live logs of your Worker (uses the account setup saved)
```

An AI agent makes this loop much faster. Give a coding agent (Claude Code, Gemini CLI, Cursor, …) a terminal and let it:

1. Start `wrangler tail` in the background and read the output.
2. Send the commands that reproduce the problem, such as `/cade task` or a message in the dev channel, using a Slack MCP server
   or browser automation (or, for a pure code path, a request to the Worker).
3. Read the logs for the error, change the code, run `npm test`, run `npm run deploy` and send the command again to check the fix.

A prompt to start with:

> Run `node scripts/wrangler.ts tail` in the background. In my dev Slack workspace's #acme-dev channel, send `/cade task`
> and create a task, then read the logs. If anything fails, find the cause in `src/`, fix it, add a test, deploy with
> `npm run deploy` and try again.

Keep tokens and secrets out of what you give an agent; use the dev workspace, not a real one. The agent can also connect to Cade
itself over MCP (see the [guide](https://xteclk.github.io/Cade/mcp.html)) to read the tasks it made.

### Running on your machine instead

`npm run dev` serves the Worker at `http://localhost:8787`, reloading as you edit. It takes the channels and time zone from
`cade.config.json`, and asks for the secrets each time without saving them (or takes them from the environment, such as
`SLACK_BOT_TOKEN=… npm run dev`). Slack can't reach `localhost`, so to try it against Slack, expose it with a tunnel (such as
`cloudflared tunnel --url http://localhost:8787`) and create a separate app for it: `npm run slack:create -- <tunnel URL> --name
"Cade Dev" --command /cadedev`. For most changes, deploying to your own Worker is simpler.

Other scripts:

| Script | Does |
| --- | --- |
| `npm run setup` | Takes you through the whole setup: Cloudflare, the Worker, the Slack app, Google, then your first group |
| `npm run config` | Checks `cade.config.json` and uploads it as Worker secrets (`PROJECTS`, `TIMEZONE`, `GOOGLE_URL`, `MCP`) |
| `npm run db:migrate` | Applies `migrations/` to the deployed D1 database; `npm run deploy` does this after deploying, and `npm run dev` for the local one |
| `npm run slack:create -- <url>` | Creates the Slack app from `slack/manifest.json` |
| `npm run slack:update` | Applies `slack/manifest.json` to the app created above |
| `npm run google:create` | Creates the Google web app (each group's executive-summary Doc) with clasp, and gives the Worker its address and secret |
| `npm run google:update` | Pushes `google/` and redeploys it to the same address |

## How it works

Slack sends three kinds of request to the Worker:

| Path | Slack feature | Handles |
| --- | --- | --- |
| `/slack/events` | Event Subscriptions | Messages: `@Cade …` commands, and plain messages Cade reacts to; opening the Home tab draws the person's dashboard (`src/home.ts`) |
| `/slack/interactions` | Interactivity | Forms, buttons and menus |
| `/slack/commands` | Slash Commands | `/cade …` |

Every request is checked against the signing secret first. Slack wants an
answer within three seconds, so slow work runs after the response, through
`waitUntil`.

Most commands are messages that start by mentioning the bot, such as
`@Cade assign @person`, because Slack doesn't allow custom slash commands in
threads and most commands are sent from a thread. Commands that start
something new outside a thread are slash commands, which can open a form
straight away.

```mermaid
flowchart LR
    Message["@Cade name … or /cade name …"]
    Parse[parse.ts: build a command]
    Dispatch[dispatch.ts: find handler, check scope]
    Handler[Command handler]
    Reply[Reply, reaction or form]

    Message --> Parse --> Dispatch --> Handler --> Reply
```

Plain messages aren't commands, but some still mean something: a pasted PR
link, a hand-off such as "@rex please look into this", "okay, started
working on this", or "LGTM". These are **intents**. A handler declares its
intents next to its commands, each with the phrases (or a test) that signal
it, what it needs (a thread, a mention), an `order`, and what to do;
`src/intents.ts` picks the first that matches. Today there are:

| Order | Intent | In | Signals |
| --- | --- | --- | --- |
| 20 | `work` | `suggest.ts` | pull request links (linked, with the people mentioned as reviewers), hand-offs ("@mia can you review this?"), the work starting ("on it"), progress ("LGTM", "QA passed", "done"), read with AI; pasted links by their text |
| 50 | `new-thread` | `move.ts` | a message posted on its own in a dev channel, not in a thread |

Each only asks the writer, privately, before changing anything, since a
phrase can match a message that didn't mean it. Questions ("done?") and
hedged messages ("not done yet") don't count as progress.

### Where things are kept

A tracked task's thread is kept in the `messages` table: each reply is stored
by the event itself (`recordMessage` in `export.ts`), and a new task's thread
is read from Slack as it is made, so Slack's 90-day limit on the free plan
doesn't lose it. The task's card links two pages of the Worker (`web.ts`): its
thread, `/t/<channel>/<ts>`, and its notes, `/n/<channel>/<ts>`, where the
AI agent's summary and notes people type are kept (`task_notes`). Pages are
for people who can read the channel and are signed in (Configure → Web pages on the Home tab signs out of every browser): the same window gives a
link that works once and sets a 30-day cookie (`web_tokens`, hashes only). The
links are built on `PUBLIC_URL`, or the address a request came by.

Tasks are stored in D1, the `DB` binding (`db.ts`, with the tables in
`migrations/`). A new one is stored before its root message is posted
(`createTask` in `commands/track.ts`), with `ts` empty until Slack takes the
post; if Slack refuses it, the cron in `wrangler.toml` posts it again every
five minutes (`retry.ts`, through `publishTask`), up to five tries in all.
Once posted, a row is found by its channel and `ts`. `loadTask` and
`saveTask` in `tasks.ts` read and write a task; `saveTask` stores the row
first, then renders it to the root message in the dev channel
(`taskMessage`). Slack is only written to, never read back: the task lists are a query of
open tasks. An incident is a task with `source_incident` set: always urgent
and due immediately. A task's PRs sent to the client with `@Cade release`
are rows of `releases`, one per release, with its PRs and what it
completes; a task is loaded with them (`getTask`), and its message shows
which PRs shipped with which release. Deleted tasks keep their rows, with
`deleted_at` set. Open tasks are pinned, for people to find in Slack.

The `requirements` table, and tasks' `source_channel`, `source_thread_ts`
and `source_link`, are left from when a group could have a client channel,
and are no longer read.

The database isn't named in `wrangler.toml`, so nothing account-specific is
committed: the first `wrangler deploy` creates one for the Worker, named
after it (`<name>-db`), and later deploys reuse it. To change the tables, add
a numbered file to `migrations/`; `npm run deploy` applies it.

### Files

| File | Role |
| --- | --- |
| `src/index.ts` | Routes, signature check, posting replies and reactions |
| `src/commands/parse.ts` | Turns a message or slash command into a command |
| `src/commands/dispatch.ts` | Finds the handler, checks where it may run, runs it, builds help |
| `src/commands/registry.ts` | The list of handlers, and the handler shape |
| `src/commands/*.ts` | One module per command: `track` (and `incident`), `assign`, `unassign`, `status`, `details` (`priority`, `due`), `pr`, `release`, `move` (and the message shortcuts), `standup`, `delete`, `replace`, `resync` (and the summary canvas's resync), `login`, `retry` |
| `src/db.ts` | Reading and writing tasks in D1 |
| `src/retry.ts` | The cron's job: posting tasks Slack refused |
| `src/tasks.ts` | The task message: layout, saving, pins |
| `src/channels.ts` | `PROJECTS`: each group's dev channel |
| `src/intents.ts` | Recognising intents in plain messages |
| `src/slack.ts` | Calling Slack, Block Kit helpers, acknowledgements |
| `src/google.ts` | Calling the Google web app |
| `src/format.ts` | Times in `TIMEZONE`, and Slack users' names |
| `src/export.ts` | Keeping each tracked thread's messages in D1 (`messages`) |
| `src/notes.ts`, `src/links.ts` | A task's notes page and the addresses of its pages |
| `src/settings.ts`, `src/commands/project.ts` | the Add project button to add a project, the Project settings button in Configure (a Slack form) for each project's switches, kept in D1 over the config, for the `admins` in the config |
| `src/web.ts`, `src/access.ts` | The Worker's pages (`/t/…` threads, `/n/…` notes), sign-in from Configure → Web pages, and who may read a channel |
| `src/doc.ts` | Writing executive summaries to each group's Google Doc, and reading them back |
| `google/` | The Google web app's Apps Script (`Code.gs`, `Doc.gs`, `appsscript.json`), and `Secret.gs`, uncommitted, which only a new web app is pushed with |
| `scripts/` | `config`, `dev`, `group`, `slack-app` and `google-app`, behind the npm scripts above |
| `migrations/` | The D1 tables, applied in order by `wrangler d1 migrations apply` |
| `slack/manifest.json` | The Slack app: scopes, events, URLs, the slash command |
| `test/index.test.ts` | The tests, with `test/d1.ts`, a stand-in database on Node's SQLite |

### Adding a command

Create a module in `src/commands/` and add it to the list in
`src/commands/registry.ts`, whose comment describes the handler shape. A
handler declares its name, how it's used, its help section, and where it may
run (which channels, and whether only in a thread); the dispatcher enforces
these and answers with a hint when a command is used in the wrong place.
Its buttons and forms are registered on the same handler, as `actions` (by
action ID) and `views` (by form callback ID), and so are any `intents`:
to recognise a new kind of message, add an `intent({ … })` to a handler's
`intents` (the comment at the top of `src/intents.ts` has the shape), or add
words to an existing list such as `HANDOFFS`. If it needs a new Slack scope
or event, add it to `slack/manifest.json` and run `npm run slack:update`.

## AI agents

Cade is also an [MCP](https://modelcontextprotocol.io) server at `/mcp` (`src/mcp.ts`), so a person's own AI agent
reads threads and tasks and works on them as that person. It speaks Streamable HTTP in its simplest form: each POST is
one JSON-RPC message (or a batch), answered with JSON, with no sessions or streams.

- **Keys.** Configure → AI agent on the Home tab (`src/commands/configure.ts`) makes the person's API key, shown once,
  with the endpoint and a link to the setup guide; revoking it there ends it. Only a hash is kept, in `mcp_tokens`. The
  key is sent in the `x-apikey` header, never in the address. `mcp: false` in `cade.config.json` turns the endpoint off.
- **Access.** Everything runs as the key's owner: a private channel's threads and tasks only for its members, and never
  a direct message.
- **Tools.** Each is defined in `src/mcp-tools.ts`: its name, description, `inputSchema` (checked before it runs; see
  above) and `outputSchema`. A result is text and `structuredContent` matching the schema, so IDs chain into the next
  call. The tools read tasks, threads, people, projects, availability, releases and executive summaries, and write
  tasks, task messages, releases, approval requests and summaries. The full list, with every argument, is
  [docs/mcp.html](docs/mcp.html), generated from `src/mcp-tools.ts`: run `npm run docs` after changing a tool (a test
  fails while it is stale). Add a tool's function to `RUNNERS` in `src/mcp.ts`: it takes its arguments as
  `src/mcp-args.ts` types them, which `npm run docs` also makes from the `inputSchema`, so the schema the agent
  sees, the check its arguments pass and the code's types can't disagree.
- **Rules for the agent.** What it is told when it connects is in `src/guardrails.ts`: above all, to show the person
  exactly what it will write and get their approval before any tool that changes something.
- **Versions.** A session ID names the tool set it loaded (a hash of the tools, the rules and the description); a tool
  called from an older session says so, and `get_server_info` reports it.
- **Summaries.** A task's summary, written by `create_task` or `update_task`, goes to the top of its notes page on the
  Worker (`/n/<channel>/<ts>`), kept in `task_notes` and marked as written by the person. After a task is made from a
  message, its form shows a short prompt to paste into the agent, naming the task by its ID (`src/commands/track.ts`);
  `aiAgentSummary: false` on a project turns that off.

## Tests

`npm test` runs `test/index.test.ts` against the real Worker, with `fetch`
replaced by a fake Slack API: `mockSlack` returns canned results and records
every call, so tests check exactly what Cade would send. Like Slack, the
fake rejects a message whose buttons share an action ID. Shared fixtures,
such as `storedTask` and `incidentTask`, build the records Cade would have
stored.
