# Contributing to Cade

Thanks for helping. Bug reports, ideas, docs fixes and code are all welcome.

## Report a bug or suggest a change

Open an [issue](https://github.com/XTECLK/Cade/issues). For a bug, say what you did, what you expected and what happened, and
the Worker's logs (`npx wrangler tail`) if you have them; leave out tokens and secrets. For a bigger change, open an issue
first so the design can be agreed before you write code. Security problems go through [SECURITY.md](SECURITY.md), not an issue.

## Send a pull request

1. Fork the repository and make a branch from `main`.
2. Set up the code as in the [development guide](DEVELOPMENT.md): `npm install`, then `npm run check`.
3. Make the change. Keep it focused: one thing per pull request.
4. Add or update tests in `test/` for what you changed, and update the docs it touches (the [website](docs/), [GETTING_STARTED.md](GETTING_STARTED.md), [DEVELOPMENT.md](DEVELOPMENT.md)).
5. Run `npm run check`: the type check and the whole suite, in a few seconds without Slack. Both must pass.
6. Open the pull request, saying what it changes and why, and link its issue.

## Style

- Follow the code around yours: TypeScript (ES modules), no build step, small functions and comments that say why.
- Type what you add, with the shared types in `src/types.ts` where they fit. Don't silence the checker with `any`, `@ts-ignore` or a cast to get past an error; fix the type, or say in a comment why the cast holds.
- A command, setting or script that people use is documented where they'll look for it: [Adding a command](DEVELOPMENT.md#adding-a-command) lists what to touch.
- Commit messages: a short summary line in the imperative ("Add update_release"), then why if it isn't obvious.

## Conduct

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
