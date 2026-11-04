# Security policy

## Reporting a vulnerability

Please don't open a public issue for a security problem. Report it privately with GitHub's
[private vulnerability reporting](https://github.com/XTECLK/Cade/security/advisories/new) on this repository.

Say what you found, how to reproduce it and what it could do. You'll get a reply, and a fix and credit (if you want it) once it is
sorted out.

## What matters most

Cade holds a Slack bot token, a signing secret, Google access and people's MCP API keys as Worker secrets. If you find a way
to read them, to act as another person, to reach a channel or task you shouldn't, or to forge a Slack or Google request, that's
a vulnerability.

## Using Cade safely

- Never commit tokens or secrets. They are set with `npx wrangler secret put` and kept out of files; `cade.config.json` and `.cade/` are ignored by git.
- If a token leaks, rotate it in Slack or Google and set the new one as a Worker secret.
- `/cade mcp revoke` deletes your MCP key.
