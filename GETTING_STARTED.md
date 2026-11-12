# Getting started

Self-host Cade for your team: one Cloudflare Worker and one Slack app. There
is no server to run;
Cade keeps its tasks, their threads and their notes in a Cloudflare D1
database that comes with the Worker, and shows them in Slack and on pages of
the Worker.

## The quick way

Cade is deployed from your own copy of its
[**cade-deploy**](https://github.com/XTECLK/cade-deploy) template, which holds your
settings and checks Cade out at the version you choose. Click **Use this
template** on that page, make the copy private, clone it (step 1), then run:

```sh
npm run setup
```

It first asks which version of Cade to deploy: a release, or `main`, the
latest development version.

It takes you through steps 2 to 7 below: Cloudflare login, the Worker, the
Slack app, the first admin, then, optionally, a GitHub token (see
`GITHUB_TOKEN` under [Secrets](#secrets-in-cloudflare-only)). It
is numbered ([1/5]…), uses arrow-key menus and Yes/No choices, offers to open the pages you need to click in, skips
what's done already, ends with a summary of what was done, and can be run again
to carry on. Tokens and secrets are asked for by the
scripts it runs, hidden, and never stored in a file.

The steps below are the same thing by hand. Each says what to run, what you
should see, and what to do if it goes wrong. Steps marked **(person)** need
someone to click in a browser.

## What you need

- Node.js 22.18 or newer, and git. Nothing to `npm install` yourself: the deploy repo fetches and installs Cade.
- A Cloudflare account (the free plan is enough).
- A Slack workspace where you can create apps.

## Settings

Cade has two kinds of settings. **Config** is what you edit as your team
changes; it lives in `cade.config.json` in your deploy repo (commit it) and
`npm run config` uploads it. **Secrets** give access to Slack;
they're set once with `npm run wrangler -- secret put NAME` and live only in
Cloudflare, never in a file. Both take effect straight away and survive every
`npm run deploy`. `npm run wrangler -- secret list` shows which are set (not their
values).

### Config: `cade.config.json`

| Key | Required? | What it is | How to get it |
| --- | --- | --- | --- |
| `projects` | Optional | Projects kept in the file, each with the settings in the next table. A project is a Slack channel where the team tracks its tasks and incidents. Projects can instead live in Cade's database: an `admins` person adds one with the Add project button on the app's Home tab, and changes its switches under Settings → Projects → Edit; projects there are kept in Cade's database (tables `projects` and `project_settings`), so `projects` can be left out of the file. | Write them by hand, or leave it out and use the Add project button on the app's Home tab (step 7). |
| `timezone` | Optional (UTC) | The time zone for times on the web pages and summaries, as an IANA name such as `Asia/Colombo`. With the proactive agent on, it's also how "Friday" or "tomorrow" in a message becomes a due date. | Your team's time zone; [the list of names](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones). |
| `admins` | Optional (none) | The Slack user IDs of the people who can add projects and change each project's switches from Slack (Settings on the app's Home tab), without editing the file. Everyone else is told only an admin can. | `npm run setup` asks for the first one. Or add `"admins": ["U0123ABCD"]` (in Slack, click the person's name or picture, then ⋯ → Copy member ID; it starts with `U`), then `npm run config`. |
| `aiModel` | Optional | The Workers AI text model that reads messages for suggestions, one for every project, such as `"@cf/google/gemma-4-26b-a4b-it"`. Without it, the default, `@cf/zai-org/glm-4.7-flash`, the quickest and cheapest that read these messages well. | Set `"aiModel"` at the top of `cade.config.json`, then `npm run config`. |
| `threadRotationDays` | Optional (off) | For Slack's free plan, which hides messages older than 90 days, the thread's root message too. An open task (not Done) whose thread is older than this many days gets a new one: once an hour, Cade posts its card again as a new root, says in the old thread that new messages go there, and starts the new thread with links to the complete history (kept by Cade) and the old thread. Links to the task and its pages, and its ID, then use the new root. | Set `"threadRotationDays": 80` in `cade.config.json` (80 leaves time to spare), then `npm run config`. Take it out to turn it off. |
| `mcp` | Optional (true) | Whether people can connect their AI agent to Cade (Settings → AI agent on the app's Home tab). `false` turns the MCP endpoint off: it answers 404, no keys are given and the new-task prompt for an agent isn't shown. Keys already made stop working, and can still be revoked. | Set `"mcp": false` in `cade.config.json`, then `npm run config`. |

Each entry in `projects` takes these. Nothing else is set at the top of the file: the settings below belong to a project, so two projects can differ.

| Key | Required? | What it is |
| --- | --- | --- |
| `name` | **Required** | The project's name, as the project picker and your agent's `get_projects` show it. |
| `channel` | **Required** | The project's Slack channel ID, where the team tracks its tasks and incidents: open the channel → click its name → **About** → **Channel ID** at the bottom (`C…`). The Add project button on the Home tab asks for it. |
| `taskChangeDetection` | Optional (`true`) | **The proactive agent**: whether Cade reads messages in the threads it manages (task and incident threads) and offers, privately, to act on them: a pasted PR link, a hand-off ("@mia can you review this?"), "on it", "lgtm" or "done", and, read with AI, a priority or due date. Each comes as one private message to whoever wrote it, with **Accept**, **Edit…** and **Reject**; nothing changes until then. `false` is **commands only**: nothing is read from messages in threads, while slash and `@Cade` commands, the task card's ⋯ menu, message shortcuts and emoji still work. |
| `newTaskDetection` | Optional (`true`) | **Task detection from new messages**: whether Cade asks about a message posted on its own in the channel, not in a thread, so it can be turned into work: track it as a task, report it as an incident, or move it to an existing thread. `false` leaves such messages alone; the same can still be done with the emoji, the message shortcuts and `@Cade` commands. It is separate from `taskChangeDetection`. |
| `summaryCanvas` | Optional (`false`) | Whether the channel has a summary canvas of its tasks, kept up to date. `true` to keep one; with `false`, none is written and `/cade resync summary` says it is off, and a canvas already made stays as it is. |

Start from `cade.config.sample.json`, which lists the options at the top of the file (the options for each project are in the table above); copy it to `cade.config.json`, keep what you need and delete the rest. `npm run config` checks the file
(names, channel IDs and time zone) and uploads nothing until it's right.

To add a project without editing the file, use the **Add project** button on the app's Home tab (step 7).

### Secrets: in Cloudflare only

| Secret | Required? | What it is | How to get it |
| --- | --- | --- | --- |
| `SLACK_SIGNING_SECRET` | **Required** | Lets Cade check that requests really come from Slack. | Set for you by `npm run slack:create` (step 5). Otherwise: the app's page at <https://api.slack.com/apps> → **Basic Information** → **App Credentials** → **Signing Secret**. |
| `SLACK_BOT_TOKEN` | **Required** | Lets Cade read and post as the app (`xoxb-…`). | After installing the app (step 6): its page → **OAuth & Permissions** → **Bot User OAuth Token**. `npm run slack:create` asks for it and stores it. |
| `GITHUB_TOKEN` | Optional | Lets Cade read whether each GitHub pull request linked to an open task is open, merged or closed, every 15 minutes, for the task cards (`Pull requests: 2 open · 1 merged`). Without it, every pull request counts as open. | `npm run github` (also the last, optional step of `npm run setup`): it opens GitHub's page for a new **classic** token with the **repo** scope ticked, asks for the token, hidden, checks it with GitHub and stores it. A classic token reads every organisation your account can, where a fine-grained one reads a single owner's repositories; `repo` is the only classic scope that reads private repositories' pull requests, though Cade only reads whether each is open, merged or closed. An organisation with SAML single sign-on needs the token authorized for it (**Configure SSO** on the token's page). |

### Used once during setup, never stored

| Credential | What it's for | How to get it |
| --- | --- | --- |
| Cloudflare login | Deploying, setting secrets and creating the database with `wrangler`. | `npm run wrangler -- login` (step 2), or an API token with **Workers Scripts → Edit** and **D1 → Edit** in `CLOUDFLARE_API_TOKEN`. |
| App configuration token | Creating or updating the Slack app (`npm run slack:create`, `slack:update`), which ask for it, hidden. | <https://api.slack.com/apps> → **Your App Configuration Tokens** → **Generate Token** (`xoxe.xoxp-…`); it lasts 12 hours. Step 4. |

`npm run dev` (see [DEVELOPMENT.md](DEVELOPMENT.md)) uses the same config file and asks for the
secrets each time, without saving them.

## 1. Get your deploy repo

Make your own copy of the template (person): on the
[cade-deploy](https://github.com/XTECLK/cade-deploy) page, click **Use this
template** and make the copy private. It holds your settings (`cade.config.json`,
`.cade/`), not Cade's code. Then:

```sh
git clone https://github.com/<you>/<your copy>.git cade-deploy
cd cade-deploy
npm run version
```

**Expect:** `No version chosen yet`. Choose one with `npm run upgrade`, or let
`npm run setup` ask. It lists Cade's releases and `main` (the latest
development version), saves your choice in `.cade/version.json`, checks that
version out into `.cade-src/` (ignored by git), runs `npm ci` and its build there. Every
`npm run` script below is run in your deploy repo and works on that checkout; that includes `npm run wrangler -- …`, which stands in for `npx wrangler`.

## 2. Log in to Cloudflare (person)

```sh
npm run wrangler -- login
npm run wrangler -- whoami
```

`wrangler login` opens a browser to approve access. **Expect:** `whoami`
prints your account name and ID. **If it fails:** run `npm run wrangler -- login`
again; on a machine without a browser, use an API token instead
(`CLOUDFLARE_API_TOKEN`, with **Workers Scripts → Edit**).

**If `whoami` lists several accounts**, give the one for Cade once, with any
npm script: `CLOUDFLARE_ACCOUNT_ID=<its ID> npm run deploy`. It's saved to
`.cade/cloudflare.json` (commit it with your deploy repo), and every npm script
uses it from then on.

## 3. Deploy the Worker

The Worker is always named `cade` (`wrangler.toml`), so its URL is
`https://cade.<your-subdomain>.workers.dev`, and one Cloudflare account holds one
Cade.

All other settings are Worker secrets, set in later steps, so nothing else
needs changing.

```sh
npm run deploy
```

The first deploy also creates the database Cade keeps its tasks in, named
after the Worker (`cade-db`), then its tables; there's nothing to copy into
`wrangler.toml`. Wrangler asks you to confirm before creating the tables.

**Expect:** a URL such as `https://cade.<your-subdomain>.workers.dev`, then
`0001_tasks_and_requirements.sql` listed with ✅. Note the URL: it's the
**Worker URL**. On a new account, Wrangler first asks you to choose your
`workers.dev` subdomain. **If the tables step fails** (for example, the
connection drops), run `npm run db:migrate`.

## 4. Get a Slack app configuration token (person)

Open <https://api.slack.com/apps>, scroll to **Your App Configuration
Tokens**, and **Generate Token** for your workspace. Copy the **Access
Token** (`xoxe.xoxp-…`). It lasts 12 hours; generate a new one when needed.

## 5. Create the Slack app

```sh
npm run slack:create -- https://cade.<your-subdomain>.workers.dev
```

Options: `--name "Acme Cade"` (default `Cade`, up to 35 characters) and
`--command /acme` (default `/cade`).

The app's name doesn't need to be unique across Slack, since it isn't
published to the marketplace; every team can call theirs Cade. If you run two
copies in one workspace (say a test copy), give them different names and
commands, because a workspace can't have two `/cade` commands. Cade's help
text always says `/cade`, so keep the default unless you need two copies.

The script creates the app from `slack/manifest.json` (scopes, events,
Interactivity and the slash command, all pointing at your Worker), stores the
signing secret in the Worker, then turns on Event Subscriptions.

**Expect:** `Created app A…`, wrangler confirming the secret, then an install
link. The app's ID is saved in `.cade/slack-app.json` (not committed).
**If it fails:**
- `invalid_auth` or `token_expired`: get a new token (step 4).
- Turning on Event Subscriptions fails: check `npm run deploy` succeeded,
  then run `npm run slack:update`.

## 6. Install the app and store the bot token (person)

Open the install link the script printed and **Allow**. Then, in the app's
**OAuth & Permissions** page, copy the **Bot User OAuth Token** (`xoxb-…`)
and paste it when the script asks. If you skipped that:

```sh
npm run wrangler -- secret put SLACK_BOT_TOKEN
```

## 7. Add your first project (person)

A **project** (a team or client) has its own **dev** channel (for example
`#acme-dev`), where the team tracks its work: tasks with `/cade task`,
setting each one's priority and due date, and incidents with `/cade
incident`, always urgent and due immediately. Messages from anywhere else,
a client's shared channel or a DM included, become tasks or incidents, or
move into one, with the message shortcuts (⋯ → **More actions**); outside
the dev channel, with more than one project, they ask which project.

Only an **admin** can add one. `npm run setup` asks for the first admin's Slack
member ID (in Slack, click the person's name or picture, then ⋯ → **Copy
member ID**, `U…`) and uploads it; by hand, put `"admins": ["U0123ABCD"]` in
`cade.config.json` and run `npm run config`.

In Slack:

1. Create a channel for the project (public or private).
2. Invite Cade to it: `/invite @Cade`.
3. Open Cade's **Home** tab (**Apps** → **Cade** → **Home**).
4. Click **Add project**, pick the channel and name the project.

Each project's switches are on the same tab, under **Settings** →
**Projects** → **Edit**. Projects added there are kept in Cade's database; ones in
`cade.config.json` work too (see [Settings](#settings)).

## 8. Check it works

1. In any channel: `/cade help` → only you see the command list.
2. In the dev channel: `/cade task` → a form; submitting posts the task.
3. In the task's thread: `@Cade status in progress` → ✅ on your message. A typed
   command gets a ✅ rather than a message in the thread; changes made from
   the card's **Edit** button, or by accepting a suggestion, are posted there
   once, as a change log followed by what it asks of the people it names
   (see [notifications](https://xteclk.github.io/Cade/notifications.html)).
4. In the same thread: `@Cade assign owner @someone` → ✅, and the thread asks
   them to pick it up. Then write a message such as "@someone can you review
   this?" → only you see a summary with **Accept**, **Edit…** and **Reject**.
5. Open **Cade** under Apps in the sidebar → the **Home** tab lists your open
   tasks (**My Tasks**, **Unassigned**, **All Tasks**). If it's blank, run
   `npm run slack:update` and reinstall the app (step 6).
6. On any message, in a DM too: ⋯ → **More actions** → **New task** →
   the task form, with a **Project** picker if you have more than one project;
   submitting posts the task and copies the message into its thread.

**If nothing answers:** run `npm run wrangler -- tail` and try again.
`Invalid signature` means the signing secret is wrong (rerun step 5 or
`wrangler secret put SLACK_SIGNING_SECRET` with the one under **Basic
Information**); `not_in_channel` means the app isn't invited;
`missing_scope` means the app needs reinstalling (step 6).

## Updating

Choose the version to update to, from your deploy repo, then deploy it:

```sh
npm run upgrade                             # lists the releases and main, and asks
npm run upgrade -- v1.3.0                   # or name one
npm run deploy                              # also applies new files in migrations/
npm run slack:update                        # only if slack/manifest.json changed
git add -A && git commit -m "Cade v1.3.0" && git push
```

A release stays as it was released. `main` follows the latest development
version: `deploy` and `slack:update` fetch its newest changes
first. `npm run version` shows what you are on; to roll back, upgrade to the
earlier release and deploy again.

If Slack says the app needs reinstalling after an update, reinstall it from
the app's page (step 6); the bot token usually stays the same.

Groups no longer have a client or incidents channel: incidents are tracked
in the dev channel, and the message shortcuts (**New task**, **New
incident**, **Move to existing**) bring in messages from anywhere. After
updating, run `npm run slack:update` for the new shortcuts, and delete each
project's old `external` and `incidents` channels from `cade.config.json`
(`npm run config` refuses them until you do). Requirements already in a client channel
are left as they were, and no longer tracked.

Workflows for people's AI agents, such as a task's summary and an executive
summary, are prompts your deploy repo keeps in `prompts/`, to change or add to.
A deploy repo made before them doesn't have the folder: copy `prompts/` from
the [cade-deploy](https://github.com/XTECLK/cade-deploy) template, add
`"prompts": "node scripts/cade.mjs prompts"` to its `package.json`, then run
`npm run deploy` (or `npm run prompts` after a change). See `prompts/README.md`
there.

Executive summaries and the Google web app are gone: after updating, delete
`googleUrl` and any project's `workDoc` from `cade.config.json` (`npm run
config` says so until you do), and `npm run wrangler -- secret delete
GOOGLE_URL` and `GOOGLE_SECRET`. The Docs stay in Google Drive, and the
Apps Script project can be deleted. The summaries kept in Cade's database are
dropped by the next `npm run deploy`.

After updating, the **Home** tab and any new shortcuts or events come with
`npm run slack:update`; Slack may then ask you to reinstall the app.

## Limits to know

- Slack's free plan hides messages older than 90 days, including old tasks'
  threads. Cade keeps every message of a tracked task's thread in its
  database as it is sent, so the task's history page still has them, and
  so do the tasks themselves. On the app's Home tab, press Settings → Web pages for a link that signs
  you in to those pages.
- D1's free plan allows 100,000 row writes a day and 500 MB per database;
  each change to a task is a single row write.
- If Slack won't take a new task or incident (for example
  while it is rate limiting), Cade keeps it and tries again every five
  minutes, five times in all, telling whoever made it the first time and if
  it gives up.
- Cade can only delete its own messages; people's replies stay.

## Good to know

- **The app icon.** Slack's manifest can't set an icon, so upload
  `slack/icon.png` (drawn from `slack/icon.svg`) under **Basic Information →
  Display Information** on the app's page at <https://api.slack.com/apps>.
- **Test channels.** Several projects can run at once (see
  [Settings](#settings)), so a test channel can sit alongside the real
  one.
- **Executive summaries** aren't written by Cade: a team that wants them
  runs a workflow with its own AI agent, such as the `executive-summary`
  prompt the deploy repo starts with (see
  [the workflows guide](https://xteclk.github.io/Cade/workflows.html)).
- **Task threads and notes** are in the
  database, on pages of the Worker (Settings → Web pages on the app's Home tab to open them).

## Using Cade

Once it's set up, send `/cade help` in Slack for the short
list, and see the [commands guide](https://xteclk.github.io/Cade/commands.html)
for every command, where it works and what it does, and the
[notifications guide](https://xteclk.github.io/Cade/notifications.html) for who
is told what when a task changes.
