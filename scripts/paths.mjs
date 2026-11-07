// Where the scripts find things.
//
//   ROOT  this checkout of Cade: the code, migrations, slack/ and google/.
//   HOME  where your deployment keeps its own files: cade.config.json,
//         .cade/ (the Cloudflare account, the Slack app, the Google web app).
//
// They are the same folder when you work in Cade itself. A deployment repo
// (the cade-deploy template) checks Cade out under its own folder and sets
// CADE_DEPLOY_DIR to itself, so what it commits stays out of the checkout and
// survives a change of version.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const slash = (path) => (path.endsWith("/") ? path : `${path}/`);

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const HOME = process.env.CADE_DEPLOY_DIR ? slash(resolve(process.env.CADE_DEPLOY_DIR)) : ROOT;
