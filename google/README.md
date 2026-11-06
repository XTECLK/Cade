# Google Docs

Each group can have its own **Google Doc**, where your agent's
`create_executive_summary` MCP tool writes its executive summaries to go through with the client and
`get_executive_summary_doc` reads back what was added. A free Google account is enough. Everything else
(tasks, threads and notes) is kept in Cade's database, not in Google.

The Worker reaches the docs through one Apps Script web app, this folder:
`Code.gs` takes each request and runs its `action`, and `Doc.gs` keeps the
docs. It's a standalone script, in no doc, serving every group, and runs as
you. It only touches the IDs the Worker gives it.

## Linking a group's Doc

```sh
npm run group -- --name acme --workDoc new
```

`new` has the web app make the file (yours, named "acme executive
summaries"); `none` unlinks. It's saved on the group in `cade.config.json` as
`workDoc`, and uploaded. A project added with `/cade project init` gets its Doc made for it (kept in
Cade's database, not in the file); nothing else makes one. A project without a Doc
can't use `create_executive_summary` or `get_executive_summary_doc`, which say so. Without the Google web app,
none is made and they say it isn't set up. Share the doc as **Editor**
with whoever goes through the summaries.

## The Doc

Cade writes in the doc's **Summary** tab, and adds the tab if the doc has
none. A group's summaries cover its tasks, incidents first. Each summary is
a section of its own, newest at the top: a heading with the day it was
written and the group, the period, then **Completed**, **Incidents** and each
health (**Blocked**, **Delayed**, **At risk**, **On track**). Every line is a
bullet whose title links to its Slack thread, with its notes as bullets under
it.

During the call, add to the section:

- **A bullet of its own, with no link**: something new, such as a task to make.
- **Bullets (or lines) under a linked one**: points for that task.
- **Changing or removing a line Cade wrote**: the client wants it changed or left out.

Afterwards your agent reads the whole section (`get_executive_summary_doc`, which marks the lines people added),
compares it with the summary Cade saved (`get_executive_summary`), and goes through the differences with you.
What the call decided is recorded next to the summary as written, so both versions are kept. Leave the
section's heading as it is: it's how Cade finds the section again (through a named range).

## Setup

1. **Log in to Google (person).** `npx clasp login` opens a browser to
   allow clasp, Google's Apps Script command line, to manage your scripts.
2. **Turn on the Apps Script API (person, once per Google account)** at
   <https://script.google.com/home/usersettings>.
3. **Create the web app:** `npm run google:create`. It creates the
   standalone script "Cade_<your Slack workspace>", generates a random secret into `Secret.gs`
   (not committed), deploys it as a web app (running as you, reachable by
   anyone: the secret is what protects it), then gives the Worker its
   address (`googleUrl` in `cade.config.json`, uploaded with `npm run
   config`) and the secret (`GOOGLE_SECRET`). Its IDs are saved to
   `.cade/google-app.json`.
4. **Approve the script (person).** Open the script link it prints, choose
   `authorize` at the top, click **Run**, and allow access to your Google Docs
   (`documents`, `drive`). Until then, the web app can't use them.
5. **Link each group's Doc** with `npm run group`, as above.

If the scripts here change, `npm run google:update` pushes them and
redeploys the same address. By hand: paste the new files, then **Deploy →
Manage deployments → Edit → Version: New version → Deploy**. Run
`authorize` again if it asks for new access. This update removes the Sheet
and the notes and thread tabs, which Cade no longer uses.

## Troubleshooting

The Worker logs `Could not add the executive summary to the doc` with the
reason in `npx wrangler tail`:

- `unauthorized`: `GOOGLE_SECRET` doesn't match `SECRET` in `Secret.gs`.
- `HTTP 401/403`: the web app's access isn't set to **Anyone**.
- `You do not have permission`, or a file that can't be found: the group's
  `workDoc` address is wrong, or you (who deployed the script) can't edit it.
- `HTTP 404` from the doc: on some Google accounts the page holding the
  script's reply is missing. Check **Executions** in Apps Script: every
  request shows as a `doPost` **Web App** run, with its error.
- "Authorization required" in **Executions**: step 4 is still to do.
