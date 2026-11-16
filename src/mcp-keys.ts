// What the rest of Cade needs of the MCP endpoint without the server itself: whether it is on, its address,
// the names of its tools, and each person's API key (made and ended from the Home tab, see
// commands/configure.ts; checked on every request, see handleMcp in mcp.ts). Only a hash of a key is kept.
import { hashToken, newToken } from "./access.ts";
import { deleteMcpToken, mcpTokenUser, putMcpToken } from "./db.ts";
import { publicUrl } from "./links.ts";
import { TOOL_DEFS } from "./mcp-tools.ts";
import type { AppEnv } from "./env.ts";

// Makes a new API key for `user`, ending any they had, and returns it. It
// can't be read again; revoking it ends it, and a new one follows.
export async function grantToken(env: AppEnv, user: string) {
  const token = newToken();
  await putMcpToken(env, user, await hashToken(token));
  return token;
}

// The address of the MCP endpoint, on the Worker.
export function endpointUrl(env: AppEnv) {
  return `${publicUrl(env)}/mcp`;
}

// Ends the user's token, and returns whether they had one.
export function revokeToken(env: AppEnv, user: string) {
  return deleteMcpToken(env, user);
}

// The user a token is for, or null.
export async function tokenUser(env: AppEnv, token: string) {
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? mcpTokenUser(env, await hashToken(token)) : null;
}

// The names of the tools, for the AI agent modal.
export function mcpCatalog() {
  return { tools: TOOL_DEFS.map((tool) => tool.name) };
}

// Whether Cade's MCP endpoint is on. It is unless the Worker secret MCP is
// "off" (`mcp: false` in cade.config.json).
export function mcpEnabled(env: Pick<AppEnv, "MCP">) {
  return env.MCP !== "off";
}
