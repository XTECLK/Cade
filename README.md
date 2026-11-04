# Cade

**C.A.D.E.**, the Central Assistant for Delivery & Execution, is a Slack
app for tracking a team's work, tasks and incidents, in its own channel.
Messages from anywhere in Slack, a DM included, can be made into tasks or
moved into one. It runs as a single Cloudflare Worker, with its tasks in a
D1 database, and your own AI agent can connect to it over MCP.

## Where to go

- **[The Cade website](https://xteclk.github.io/Cade/)**: what it does, [every command](https://xteclk.github.io/Cade/commands.html) and [how to connect your agent](https://xteclk.github.io/Cade/mcp.html).
- **[Getting started](GETTING_STARTED.md)**: set Cade up for your team. Run `npm run setup` and a guided script does it with you.
- **[Development guide](DEVELOPMENT.md)**: how it's built, and how to run and test it.
- **[Contributing](CONTRIBUTING.md)**: how to report a bug, suggest a change or send a pull request.
- **[Issues](https://github.com/XTECLK/Cade/issues)**: the changes planned for Cade, each with its design and status.

## Quick start

```sh
git clone https://github.com/XTECLK/Cade.git && cd Cade
npm install
npm run setup
```

## Community

Please read the [Code of Conduct](CODE_OF_CONDUCT.md). To report a security problem, see [SECURITY.md](SECURITY.md).
