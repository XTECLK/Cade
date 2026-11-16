// Projects added from the Home tab, and the settings changed there, kept over cade.config.json's (see
// settings.ts).
import type { DbEnv } from "./common.ts";

// The settings changed in the project settings form, as { channel, key, value (JSON) }.
export async function projectSettings(env: DbEnv) {
  const { results } = await env.DB.prepare("SELECT channel, key, value FROM project_settings").all<{
    channel: string;
    key: string;
    value: string;
  }>();
  return results;
}

export async function setProjectSetting(env: DbEnv, channel: string, key: string, value: unknown, user: string | null) {
  await env.DB.prepare(
    `INSERT INTO project_settings (channel, key, value, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT (channel, key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(channel, key, JSON.stringify(value), user)
    .run();
}

export async function clearProjectSetting(env: DbEnv, channel: string, key: string) {
  await env.DB.prepare("DELETE FROM project_settings WHERE channel = ? AND key = ?").bind(channel, key).run();
}

// The projects added with the Add project button, as { channel, name }.
export async function addedProjects(env: DbEnv) {
  const { results } = await env.DB.prepare("SELECT channel, name FROM projects ORDER BY rowid").all<{
    channel: string;
    name: string;
  }>();
  return results;
}

export async function addProject(env: DbEnv, channel: string, name: string, user: string) {
  await env.DB.prepare("INSERT INTO projects (channel, name, created_by) VALUES (?, ?, ?)")
    .bind(channel, name, user)
    .run();
}
