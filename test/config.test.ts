import assert from "node:assert/strict";
import test from "node:test";
import { env, mockSlack, send, threadEvent } from "./app.ts";

test("a group without a name is reported", async (t) => {
  const calls = mockSlack(t);
  await send(
    "/slack/events",
    threadEvent("<@UBOT> assign tester <@UBOB>"),
    {},
    {
      ...env,
      PROJECTS: [{ channel: "CDEV" }],
    },
  );
  assert.equal(calls[0].args.text, "Sorry, something went wrong with `assign`. Could you try again?");
});

test("PROJECTS can be a JSON string, as the Cloudflare dashboard stores it", async (t) => {
  const calls = mockSlack(t);
  const asJson = { ...env, PROJECTS: JSON.stringify(env.PROJECTS) };
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>", { channel: "COTHER" }), {}, asJson);
  assert.equal(
    calls[0].args.text,
    "That one works with `@Cade assign owner @person` in a task thread in <#CDEV> or <#CTESTDEV>.",
  );

  const broken = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>"), {}, { ...env, PROJECTS: "[{" });
  assert.match(broken[0].args.text, /something went wrong/);
});

test("the Slack app manifest is filled in from the Worker's URL, name and command", async () => {
  const { buildManifest } = await import("../scripts/slack-app.ts");
  const { readFile } = await import("node:fs/promises");
  const template = JSON.parse(await readFile(new URL("../slack/manifest.json", import.meta.url), "utf8"));
  const settings = { workerUrl: "https://cade.acme.workers.dev/", name: "Acme Cade", command: "/acme" };

  const manifest = buildManifest(template, settings);
  assert.equal(manifest._comment, undefined, "Slack doesn't accept extra keys");
  assert.equal(manifest.display_information.name, "Acme Cade");
  assert.equal(manifest.features.bot_user.display_name, "Acme Cade");
  const [command] = manifest.features.slash_commands;
  assert.equal(command.command, "/acme");
  // The trailing slash is dropped, so the paths are clean.
  assert.equal(command.url, "https://cade.acme.workers.dev/slack/commands");
  assert.equal(manifest.settings.interactivity.request_url, "https://cade.acme.workers.dev/slack/interactions");
  assert.equal(manifest.settings.event_subscriptions.request_url, "https://cade.acme.workers.dev/slack/events");
  assert.ok(!JSON.stringify(manifest).includes("{{"), "every placeholder is filled in");

  // Created first without Event Subscriptions, whose URL Slack checks before
  // the Worker has the signing secret.
  assert.equal(buildManifest(template, { ...settings, events: false }).settings.event_subscriptions, undefined);
  assert.ok(template.settings.event_subscriptions, "the template is left as it was");
});

test("the manifest asks for the scopes Cade uses", async () => {
  const { readFile } = await import("node:fs/promises");
  const template = JSON.parse(await readFile(new URL("../slack/manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(template.oauth_config.scopes.bot, [
    "canvases:write",
    "channels:history",
    "channels:join",
    "channels:manage",
    "channels:read",
    "chat:write",
    "commands",
    "groups:history",
    "groups:read",
    "groups:write",
    // 🎫 and 🔀 on a message convert or move it.
    "reactions:read",
    "reactions:write",
    "users:read",
    "users:read.email",
  ]);
  assert.deepEqual(template.settings.event_subscriptions.bot_events, [
    // Opening the Home tab draws the person's dashboard.
    "app_home_opened",
    "message.channels",
    "message.groups",
    "reaction_added",
  ]);
  assert.equal(template.features.app_home.home_tab_enabled, true);
});

test("npm run config sets MCP on or off from mcp", async () => {
  const { readConfig } = await import("../scripts/config.ts");
  const projects = [{ name: "acme", channel: "C0000000002" }];
  assert.equal(readConfig(JSON.stringify({ projects })).MCP, undefined);
  assert.equal(readConfig(JSON.stringify({ projects, mcp: false })).MCP, "off");
  assert.equal(readConfig(JSON.stringify({ projects, mcp: true })).MCP, "on");
  assert.throws(() => readConfig(JSON.stringify({ projects, mcp: "no" })), /mcp is true or false/);
});

test("npm run config sets ADMINS from admins, always, and checks them", async () => {
  const { readConfig } = await import("../scripts/config.ts");
  const projects = [{ name: "acme", channel: "C0000000002" }];
  assert.equal(readConfig(JSON.stringify({ projects })).ADMINS, "[]");
  assert.equal(readConfig(JSON.stringify({ projects, admins: ["UANN", "UBOB", "UANN"] })).ADMINS, '["UANN","UBOB"]');
  assert.throws(() => readConfig(JSON.stringify({ projects, admins: ["ann"] })), /admins is a list of Slack user IDs/);
  assert.throws(() => readConfig(JSON.stringify({ projects, admins: "UANN" })), /admins is a list of Slack user IDs/);
});

test("npm run config checks the summaryCanvas and newTaskDetection switches, and says activeTasksPinning is gone", async () => {
  const { readConfig } = await import("../scripts/config.ts");
  const projects = [{ name: "acme", channel: "C0000000002" }];
  const set = JSON.parse(
    readConfig(JSON.stringify({ projects: [{ ...projects[0], summaryCanvas: true, newTaskDetection: false }] }))
      .PROJECTS,
  )[0];
  assert.deepEqual([set.summaryCanvas, set.newTaskDetection], [true, false]);
  assert.throws(
    () => readConfig(JSON.stringify({ projects: [{ ...projects[0], summaryCanvas: "no" }] })),
    /acme's summaryCanvas is true or false/,
  );
  assert.throws(
    () => readConfig(JSON.stringify({ projects, summaryCanvas: true })),
    /"summaryCanvas" at the top; set it on each project/,
  );
  // Pinning was removed: a config that still sets it is told to delete it, whatever it says.
  for (const value of [true, false]) {
    assert.throws(
      () => readConfig(JSON.stringify({ projects: [{ ...projects[0], activeTasksPinning: value }] })),
      /acme's activeTasksPinning is no longer a setting: Cade doesn't pin tasks .* Delete it\./,
    );
  }
});
test("slack:create checks its settings before calling Slack", async () => {
  const { checkSettings } = await import("../scripts/slack-app.ts");
  assert.deepEqual(checkSettings({ workerUrl: "https://cade.acme.workers.dev", name: "Cade", command: "/cade" }), []);
  assert.equal(checkSettings({ workerUrl: "http://cade", name: "Cade", command: "/cade" }).length, 1);
  assert.equal(checkSettings({ workerUrl: "https://cade.dev", name: "x".repeat(36), command: "/cade" }).length, 1);
  assert.equal(checkSettings({ workerUrl: "https://cade.dev", name: "Cade", command: "cade" }).length, 1);
});

test("npm run config checks the suggestions setting", async () => {
  const { readConfig } = await import("../scripts/config.ts");
  const projects = [{ name: "acme", channel: "C0000000002" }];
  const suggestions = (value) =>
    JSON.parse(readConfig(JSON.stringify({ projects: [{ ...projects[0], taskChangeDetection: value }] })).PROJECTS)[0]
      .taskChangeDetection;
  assert.equal(suggestions(false), false);
  assert.equal(suggestions(true), true);
  assert.throws(() => suggestions(["pr-links"]), /acme's taskChangeDetection is true or false/);
  assert.throws(() => suggestions("off"), /acme's taskChangeDetection is true or false/);
});

test("npm run config turns cade.config.json into the Worker's secrets", async () => {
  const { readConfig } = await import("../scripts/config.ts");
  const projects = [{ name: "acme", channel: "C0000000002" }];
  assert.deepEqual(readConfig(JSON.stringify({ timezone: "Asia/Colombo", projects })), {
    PROJECTS: JSON.stringify(projects),
    ADMINS: "[]",
    AI_MODEL_NAME: "",
    THREAD_ROTATION_DAYS: "",
    TIMEZONE: "Asia/Colombo",
  });
  // The timezone is optional.
  assert.deepEqual(readConfig(JSON.stringify({ projects })), {
    PROJECTS: JSON.stringify(projects),
    ADMINS: "[]",
    AI_MODEL_NAME: "",
    THREAD_ROTATION_DAYS: "",
  });
});

test("npm run config stops on a mistake, before uploading anything", async () => {
  const { readConfig } = await import("../scripts/config.ts");
  const good = [{ name: "acme", channel: "C0000000002" }];
  for (const [config, problem] of [
    ["{", /not valid JSON/],
    [{ projects: [{ channel: "C0000000002" }] }, /must list \{ name, channel \}/],
    [{ projects: [{ name: "acme" }] }, /must list \{ name, channel \}/],
    [{ projects: [{ name: "acme", channel: "#acme-dev" }] }, /doesn't look like a Slack channel ID/],
    [
      {
        projects: [
          { name: "acme", channel: "C0000000001" },
          { name: "beta", channel: "C0000000001" },
        ],
      },
      /used twice/,
    ],
    [{ projects: good, timezone: "Sri Lanka" }, /isn't a time zone/],
    // A token here would be a mistake: they belong in Cloudflare only.
    [{ projects: good, SLACK_BOT_TOKEN: "xoxb-1" }, /has "SLACK_BOT_TOKEN"; it takes projects and timezone/],
  ] as const) {
    assert.throws(() => readConfig(typeof config === "string" ? config : JSON.stringify(config)), problem);
  }
});

test("npm run dev passes its settings to Wrangler as a quoted .env file", async () => {
  const { envFile } = await import("../scripts/dev.ts");
  const pairs = JSON.stringify([{ name: "acme", channel: "C0000000002" }]);
  assert.equal(
    envFile({ PROJECTS: pairs, TIMEZONE: "UTC", SLACK_BOT_TOKEN: "xoxb-1", PUBLIC_URL: undefined }),
    `PROJECTS='${pairs}'\nTIMEZONE='UTC'\nSLACK_BOT_TOKEN='xoxb-1'`,
  );
  assert.throws(() => envFile({ SLACK_SIGNING_SECRET: "it's" }), /can't contain a quote/);
});

test("npm run dev asks for Slack's two secrets", async () => {
  const { SECRETS } = await import("../scripts/dev.ts");
  assert.deepEqual(
    SECRETS.map(({ name }) => name),
    ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"],
  );
  assert.deepEqual(
    SECRETS.filter((secret) => !secret.optional && !secret.when).map(({ name }) => name),
    ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"],
  );
});

test("cade.config.json refuses googleUrl and workDoc, which went with executive summaries", async () => {
  const { readConfig } = await import("../scripts/config.ts");
  const projects = [{ name: "acme", channel: "C0000000002" }];
  assert.throws(
    () => readConfig(JSON.stringify({ projects, googleUrl: "https://script.google.com/macros/s/AKfy-abc/exec" })),
    /googleUrl is no longer a setting.*Delete it/,
  );
  assert.throws(
    () =>
      readConfig(
        JSON.stringify({ projects: [{ ...projects[0], workDoc: "https://docs.google.com/document/d/x/edit" }] }),
      ),
    /acme's workDoc is no longer a setting.*Delete it/,
  );
  assert.equal(readConfig(JSON.stringify({ projects })).GOOGLE_URL, undefined);
  // The old settings, and the secret, stay out of the file.
  assert.throws(() => readConfig(JSON.stringify({ projects, sheetUrl: "x" })), /has "sheetUrl"/);
  assert.throws(() => readConfig(JSON.stringify({ projects, googleSecret: "s" })), /has "googleSecret"/);
});

test("the Slack app's description fits Slack's 140 characters", async () => {
  const { readFile } = await import("node:fs/promises");
  const template = JSON.parse(await readFile(new URL("../slack/manifest.json", import.meta.url), "utf8"));
  assert.ok(template.display_information.description.length <= 140);
});

test("npm run setup leaves secrets and tokens to the scripts it runs", async () => {
  const { readFile } = await import("node:fs/promises");
  const script = await readFile(new URL("../scripts/setup.ts", import.meta.url), "utf8");
  // It sets no secrets itself.
  assert.doesNotMatch(script, /secret put/);
  // Nor does it ask for a token: slack:create does, hidden.
  assert.doesNotMatch(script, /askHidden/);
  assert.doesNotMatch(script, /ask\([^)]*token/i);
  const guide = await readFile(new URL("../GETTING_STARTED.md", import.meta.url), "utf8");
  assert.match(guide, /npm run setup/);
});

test("npm run slack:create asks for both tokens hidden", async () => {
  const { readFile } = await import("node:fs/promises");
  const script = await readFile(new URL("../scripts/slack-app.ts", import.meta.url), "utf8");
  assert.match(script, /askHidden\("Bot token/);
  assert.doesNotMatch(script, /createInterface/);
});

test("npm run config sets THREAD_ROTATION_DAYS from threadRotationDays, always, and checks it", async () => {
  const { readConfig } = await import("../scripts/config.ts");
  const projects = [{ name: "acme", channel: "C0000000002" }];
  assert.equal(readConfig(JSON.stringify({ projects, threadRotationDays: 80 })).THREAD_ROTATION_DAYS, "80");
  assert.equal(readConfig(JSON.stringify({ projects })).THREAD_ROTATION_DAYS, "");
  for (const days of [0, 1.5, "80"])
    assert.throws(
      () => readConfig(JSON.stringify({ projects, threadRotationDays: days })),
      /threadRotationDays is a whole number/,
    );
});

test("npm run github stores a classic token with the repo scope, warns about a fine-grained one, and refuses others", async () => {
  const { checkToken, NEW_TOKEN_URL } = await import("../scripts/github.ts");
  const asked: { url: string; authorization: string | null }[] = [];
  const github = (status: number, scopes: string | null, body: unknown = { login: "isuru" }) =>
    (async (url, init) => {
      asked.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify(body), {
        status,
        headers: scopes === null ? {} : { "x-oauth-scopes": scopes },
      });
    }) as typeof fetch;

  assert.deepEqual(await checkToken("ghp_ok", github(200, "read:org, repo")), { login: "isuru" });
  assert.deepEqual(asked[0], { url: "https://api.github.com/user", authorization: "bearer ghp_ok" });
  assert.deepEqual(await checkToken("github_pat_x", github(200, null)), { login: "isuru", narrow: true });
  assert.match((await checkToken("ghp_public", github(200, "public_repo"))).problem!, /doesn't have the repo scope/);
  assert.match((await checkToken("ghp_bad", github(401, null))).problem!, /doesn't accept that token/);
  assert.match((await checkToken("ghp_down", github(503, null))).problem!, /HTTP 503/);
  // The page it opens asks for a classic token with repo ticked.
  assert.match(NEW_TOKEN_URL, /^https:\/\/github\.com\/settings\/tokens\/new\?scopes=repo&/);
});

test("npm run config checks each group's suggestions", async () => {
  const { readConfig } = await import("../scripts/config.ts");
  const projects = [
    { name: "acme", channel: "C0000000002", taskChangeDetection: true },
    { name: "test", channel: "C0000000003", taskChangeDetection: false },
  ];
  assert.deepEqual(JSON.parse(readConfig(JSON.stringify({ projects })).PROJECTS), [projects[0], projects[1]]);
  assert.throws(
    () => readConfig(JSON.stringify({ projects: [{ ...projects[1], taskChangeDetection: ["nope"] }] })),
    /test's taskChangeDetection is true or false/,
  );
});

test("scripts keep a deployment's files in CADE_DEPLOY_DIR, and in the checkout without it", async () => {
  const { execFileSync } = await import("node:child_process");
  const show = (env) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          'import {HOME,ROOT} from "./scripts/paths.ts"; console.log(JSON.stringify({HOME,ROOT}))',
        ],
        {
          env: { ...process.env, CADE_DEPLOY_DIR: "", ...env },
          encoding: "utf8",
        },
      ),
    );
  const alone = show({});
  assert.equal(alone.HOME, alone.ROOT);
  assert.equal(show({ CADE_DEPLOY_DIR: "/tmp/acme-deploy" }).HOME, "/tmp/acme-deploy/");
});

test("npm run config refuses what cade.config.json can't say, such as a misspelt setting, which would do nothing", async () => {
  const { readConfig } = await import("../scripts/config.ts");
  const acme = { name: "acme", channel: "C0000000002" };
  for (const [config, problem] of [
    // A setting on a project the Worker doesn't read, misspelt or from an older format.
    [
      { projects: [{ ...acme, summaryCanvass: true }] },
      /project acme: summaryCanvass isn't something this takes; it takes name, channel, taskChangeDetection/,
    ],
    [
      { projects: [{ ...acme, sheet: "https://docs.google.com/spreadsheets/d/x/edit" }] },
      /project acme: sheet isn't something this takes/,
    ],
    // A project's people are its channel's, so they aren't listed.
    [{ projects: [{ ...acme, members: ["UANN"] }] }, /project acme: members isn't something this takes/],
    [{ projects: [{ ...acme, name: 7 }] }, /must list \{ name, channel \}|project 7: name is text\./],
    // The top of the file.
    [{ projects: [acme], timezone: 5 }, /timezone|isn't a time zone/],
    [{ projects: [acme], aiModel: 42 }, /aiModel is a Workers AI/],
  ] as const) {
    assert.throws(() => readConfig(JSON.stringify(config)), problem, JSON.stringify(config));
  }
  // What it does take is uploaded as it was.
  const members = { ...acme, summaryCanvas: true };
  assert.deepEqual(JSON.parse(readConfig(JSON.stringify({ projects: [members], mcp: true })).PROJECTS), [members]);
});
