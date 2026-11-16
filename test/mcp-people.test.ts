import assert from "node:assert/strict";
import test from "node:test";
import { putTask } from "../src/db.ts";
import { addressIn, env, mock, slash, stored, tool } from "./mcp-app.ts";

test("get_user gives a user's name from an ID or a mention", async (t) => {
  mock(t, {
    "users.info": (args) =>
      args.user === "UBOB"
        ? { user: { real_name: "Bob Jones", profile: { display_name: "bobby" } } }
        : new Error("user_not_found"),
  });
  const url = addressIn(await slash("mcp init"));
  assert.equal((await tool(url, "get_user", { user_id: "UBOB" })).text, "Bob Jones (bobby)");
  assert.equal((await tool(url, "get_user", { user_id: "<@UBOB>" })).text, "Bob Jones (bobby)");
  assert.match((await tool(url, "get_user", { user_id: "bob" })).text, /isn't a Slack user ID/);
  assert.match((await tool(url, "get_user", { user_id: "UGONE" })).text, /couldn't look up UGONE/);
});

test("get_users lists the people of the workspace, up to a limit", async (t) => {
  const calls = mock(t, {
    "users.list": {
      members: [
        { id: "UANN", name: "ann.lee", real_name: "Ann Lee" },
        { id: "UBOT", name: "robot", real_name: "A Bot", is_bot: true },
        { id: "UGONE", name: "old", real_name: "Old", deleted: true },
        { id: "UBOB", name: "bob", real_name: "Bob" },
        { id: "UCAT", name: "cat", real_name: "Cat" },
      ],
    },
  });
  const url = addressIn(await slash("mcp init", "UME"));
  assert.equal(
    (await tool(url, "get_users", {})).text,
    ["3 people:", "Ann Lee (ann.lee): UANN", "Bob (bob): UBOB", "Cat (cat): UCAT"].join("\n"),
  );
  // fields gives only what is asked for; user_id is always there.
  const named = await tool(url, "get_users", { fields: ["name"] });
  assert.deepEqual(named.data.users, [
    { user_id: "UANN", name: "Ann Lee" },
    { user_id: "UBOB", name: "Bob" },
    { user_id: "UCAT", name: "Cat" },
  ]);
  assert.equal(named.text, ["3 people:", "Ann Lee: UANN", "Bob: UBOB", "Cat: UCAT"].join("\n"));
  assert.deepEqual(
    (await tool(url, "get_users", { fields: [] })).data.users.map((person) => Object.keys(person)),
    [["user_id"], ["user_id"], ["user_id"]],
  );
  assert.deepEqual((await tool(url, "find_user_by_name", { name: "ann", fields: ["username"] })).data.users, [
    { user_id: "UANN", username: "ann.lee" },
  ]);
  assert.match((await tool(url, "get_users", { fields: ["email"] })).text, /fields is a list of: name, username/);
  assert.match(
    (await tool(url, "get_users", { limit: 2 })).text,
    /^3 people, showing the first 2; raise limit \(up to 200\) or use find_user_by_name:\nAnn Lee/,
  );
  for (const limit of [0, 201, 2.5, "5"])
    assert.match((await tool(url, "get_users", { limit })).text, /limit is a whole number from 1 to 200/);
  assert.ok(calls.filter((call) => !call.method.startsWith("views.")).every((call) => call.method === "users.list"));
});

test("find_user_by_name gives the IDs of people by name", async (t) => {
  mock(t, {
    "users.list": {
      members: [
        { id: "UANN", name: "ann.lee", real_name: "Ann Lee", profile: { display_name: "annl" } },
        { id: "UBOT", name: "robot", real_name: "Ann Bot", is_bot: true },
        { id: "UGONE", name: "ann.old", real_name: "Ann Old", deleted: true },
        { id: "UBOB", name: "bob", real_name: "Bob" },
      ],
    },
  });
  const url = addressIn(await slash("mcp init", "UME"));
  const found = (await tool(url, "find_user_by_name", { name: "ann" })).text;
  assert.match(found, /1 match:\nAnn Lee \(ann\.lee\): UANN/);
  assert.match((await tool(url, "find_user_by_name", { name: "zed" })).text, /No one in the workspace matches/);
  assert.match((await tool(url, "find_user_by_name", { name: "a" })).text, /at least two letters/);
});

test("get_team_availability ranks people by open workload and shows their status", async (t) => {
  const future = Math.floor(Date.now() / 1000) + 86400;
  const calls = mock(t, {
    "users.list": {
      members: [
        { id: "UANN", name: "ann", real_name: "Ann", tz: "Asia/Colombo" },
        {
          id: "UBOB",
          name: "bob",
          real_name: "Bob",
          profile: { status_text: "On vacation", status_expiration: future },
        },
        { id: "UCAT", name: "cat", real_name: "Cat", profile: { status_text: "Lunch", status_expiration: 1 } },
        { id: "UBOT", name: "robot", real_name: "Bot", is_bot: true },
      ],
    },
    "users.getPresence": (args) => ({ presence: args.user === "UANN" ? "active" : "away" }),
  });
  const url = addressIn(await slash("mcp init", "UME"));
  const result = await tool(url, "get_team_availability", {
    fields: ["name", "open_tasks", "status", "status_until", "time_zone", "away", "presence"],
  });
  assert.deepEqual(
    result.data.people.map((person) => person.user_id),
    ["UANN", "UCAT", "UBOB"],
  );
  const [ann, cat, bob] = result.data.people;
  assert.equal(ann.presence, "active");
  assert.equal(ann.time_zone, "Asia/Colombo");
  assert.equal(cat.status, "");
  assert.equal(bob.away, true);
  assert.match(bob.status_until, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!result.data.people.some((person) => person.user_id === "UBOT"));
  assert.equal(calls.filter((call) => call.method === "users.getPresence").length, 3);
  // Presence is looked up only when asked for in fields, and fields keeps only what is named (user_id is always there).
  calls.length = 0;
  const slim = await tool(url, "get_team_availability", { fields: ["name", "open_tasks"] });
  assert.deepEqual(slim.data.people[0], { user_id: "UANN", name: "Ann", open_tasks: 0 });
  assert.equal(calls.filter((call) => call.method === "users.getPresence").length, 0);
  assert.match((await tool(url, "get_team_availability", { fields: ["email"] })).text, /fields is a list of: /);
  assert.deepEqual(
    (await tool(url, "get_team_availability", { users: ["UBOB"] })).data.people.map((person) => person.user_id),
    ["UBOB"],
  );
  assert.deepEqual(
    (await tool(url, "get_team_availability", { limit: 1 })).data.people.map((person) => person.user_id),
    ["UANN"],
    "limit keeps the least loaded",
  );
  assert.match((await tool(url, "get_team_availability", { limit: 0 })).text, /limit is a whole number from 1 to 200/);
  assert.match(
    (await tool(url, "get_team_availability", { users: ["bob"] })).text,
    /users is a list of Slack user IDs/,
  );
});

test("availability counts everyone's open tasks, in channels the person asking isn't in too, and names none of them", async (t) => {
  const people = (owner: string[]) => ({ owner, reviewer: [], tester: [] });
  await putTask(
    env,
    "CDEV",
    "1700000000.000100",
    stored({ title: "Dev's", priority: "Low", people: people(["UBOB"]) }),
  );
  // CPRIV is private, and UME isn't in it.
  await putTask(
    env,
    "CPRIV",
    "1700000001.000100",
    stored({ title: "Secret", priority: "Urgent", people: people(["UBOB"]) }),
  );
  mock(t, { "users.list": { members: [{ id: "UBOB", name: "bob", real_name: "Bob" }] } });
  const url = addressIn(await slash("mcp init", "UME"));
  const bob = await tool(url, "get_availability", { user_id: "UBOB" });
  assert.equal(bob.data.person.open_tasks, 2);
  assert.equal(bob.data.person.urgent_or_high, 1);
  assert.doesNotMatch(bob.text, /Secret|CPRIV/);
  assert.equal((await tool(url, "get_team_availability", {})).data.people[0].open_tasks, 2);
});

test("availability for a project covers only the people in its channel", async (t) => {
  mock(t, {
    "users.list": { members: ["UANN", "UBOB", "UCAT"].map((id) => ({ id, name: id, real_name: id.slice(1) })) },
    "conversations.info": (args) => ({
      channel: args.channel === "CDEV" ? { name: "dev" } : { name: "bare", is_private: true },
    }),
    "conversations.members": (args) => ({
      members: args.channel === "CDEV" ? ["UME", "UBOB", "UCAT", "UCADEBOT"] : ["UANN"],
    }),
  });
  const url = addressIn(await slash("mcp init", "UME"));
  const ids = async (args) =>
    (await tool(url, "get_team_availability", args)).data.people.map((person) => person.user_id);
  assert.deepEqual(await ids({ project: "acme" }), ["UBOB", "UCAT"]);
  assert.deepEqual(await ids({}), ["UANN", "UBOB", "UCAT"]);
  assert.deepEqual(await ids({ project: "acme", users: ["UANN", "UBOB"] }), ["UBOB"]);
  assert.equal((await tool(url, "get_availability", { user_id: "UBOB", project: "acme" })).data.person.user_id, "UBOB");
  assert.match(
    (await tool(url, "get_availability", { user_id: "UANN", project: "acme" })).text,
    /UANN isn't in acme's channel/,
  );
  // A private channel's people are only for someone in it to ask about.
  assert.match(
    (await tool(url, "get_team_availability", { project: "bare" })).text,
    /aren't in that project's channel/,
  );
});

test("get_availability gives one person's workload and status", async (t) => {
  mock(t, {
    "users.list": {
      members: [
        { id: "UANN", name: "ann", real_name: "Ann", profile: { status_text: "Sick leave" } },
        { id: "UBOB", name: "bob", real_name: "Bob" },
      ],
    },
    "users.getPresence": { presence: "away" },
  });
  const url = addressIn(await slash("mcp init", "UME"));
  const ann = await tool(url, "get_availability", { user_id: "UANN", fields: ["name", "away", "presence"] });
  assert.deepEqual(ann.data.person, { user_id: "UANN", name: "Ann", away: true, presence: "away" });
  assert.match(ann.text, /^Ann \(UANN\)/);
  assert.match((await tool(url, "get_availability", { user_id: "UNOBODY" })).text, /no active person UNOBODY/);
  assert.match((await tool(url, "get_availability", {})).text, /Give user_id\./);
});

test("get_user gives a person's email, phone and title only when asked", async (t) => {
  mock(t, {
    "users.info": {
      user: {
        real_name: "Bob Jones",
        profile: { display_name: "bobby", email: "bob@example.com", phone: "+94 77 123 4567", title: "Developer" },
      },
    },
  });
  const url = addressIn(await slash("mcp init"));
  const plain = await tool(url, "get_user", { user_id: "UBOB" });
  assert.equal(plain.data.profile, null);
  assert.ok(!plain.text.includes("example.com") && !plain.text.includes("4567"));
  const full = await tool(url, "get_user", { user_id: "UBOB", profile: true });
  assert.deepEqual(full.data.profile, { email: "bob@example.com", phone: "+94 77 123 4567", title: "Developer" });
  assert.match(full.text, /Phone: \+94 77 123 4567/);
});
