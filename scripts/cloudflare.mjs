// The Cloudflare account Cade is deployed to, for every npm script that runs
// wrangler. A login with several accounts otherwise makes wrangler ask, or
// fail when it can't, each time.
//
// It's kept in .cade/cloudflare.json as { "accountId" }, written the first time a
// script runs with CLOUDFLARE_ACCOUNT_ID set, as in
// `CLOUDFLARE_ACCOUNT_ID=… npm run deploy`; from then on, importing this sets
// it for wrangler, and the scripts it starts, unless it's set already.
//
// A custom domain for the Worker can be added by hand as { "domain" }, such as
// "api.example.com"; `wrangler.mjs` then deploys to it (see there), so
// wrangler.toml stays free of anyone's domain.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { HOME } from "./paths.mjs";

const FILE = `${HOME}.cade/cloudflare.json`;

function read() {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

// Saves `patch` in the file with the rest of it.
export function save(patch) {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, `${JSON.stringify({ ...read(), ...patch }, null, 2)}\n`);
}

export const domain = read().domain;
const accountId = read().accountId;
if (!process.env.CLOUDFLARE_ACCOUNT_ID && accountId) {
  process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
} else if (process.env.CLOUDFLARE_ACCOUNT_ID && !accountId && !process.env.NODE_TEST_CONTEXT) {
  save({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID });
  console.log(`Saved Cloudflare account ${process.env.CLOUDFLARE_ACCOUNT_ID} to .cade/cloudflare.json; it needn't be given again.`);
}
