// Each project's summary canvas: its ID, the hash of what it last showed, and whether it needs writing again
// (see summary.ts).
import type { DbEnv } from "./common.ts";

export async function getCanvas(env: DbEnv, channel: string) {
  const row = await env.DB.prepare("SELECT canvas_id FROM canvases WHERE channel = ?")
    .bind(channel)
    .first<{ canvas_id: string | null }>();
  return row?.canvas_id ?? null;
}

export async function putCanvas(env: DbEnv, channel: string, canvasId: string, user: string) {
  await env.DB.prepare(
    `INSERT INTO canvases (channel, canvas_id, created_by) VALUES (?, ?, ?)
     ON CONFLICT (channel) DO UPDATE SET canvas_id = excluded.canvas_id, created_by = excluded.created_by`,
  )
    .bind(channel, canvasId, user)
    .run();
}

// The hash of the markdown last written to the channel's canvas, or null.
export async function getCanvasHash(env: DbEnv, channel: string) {
  const row = await env.DB.prepare("SELECT content_hash FROM canvases WHERE channel = ?")
    .bind(channel)
    .first<{ content_hash: string | null }>();
  return row?.content_hash ?? null;
}

export async function setCanvasHash(env: DbEnv, channel: string, hash: string) {
  await env.DB.prepare("UPDATE canvases SET content_hash = ? WHERE channel = ?").bind(hash, channel).run();
}

// Marks the channel's summary as out of date, under `token`. Only a channel
// with a canvas is marked, unless `create`: a group's first task adds its
// row, which has no canvas until the summary is rendered.
export async function markCanvasDirty(env: DbEnv, channel: string, token: string, create = false) {
  const statement = create
    ? env.DB.prepare(
        `INSERT INTO canvases (channel, dirty_token) VALUES (?, ?)
         ON CONFLICT (channel) DO UPDATE SET dirty_token = excluded.dirty_token`,
      ).bind(channel, token)
    : env.DB.prepare("UPDATE canvases SET dirty_token = ? WHERE channel = ?").bind(token, channel);
  await statement.run();
}

// The token the channel's summary was last marked with, or null if it is up
// to date.
export async function getCanvasDirty(env: DbEnv, channel: string) {
  const row = await env.DB.prepare("SELECT dirty_token FROM canvases WHERE channel = ?")
    .bind(channel)
    .first<{ dirty_token: string | null }>();
  return row?.dirty_token ?? null;
}

// Marks the summary up to date, unless it was marked again since `token`.
export async function clearCanvasDirty(env: DbEnv, channel: string, token: string) {
  await env.DB.prepare("UPDATE canvases SET dirty_token = NULL WHERE channel = ? AND dirty_token = ?")
    .bind(channel, token)
    .run();
}

// The channels whose summary is out of date, with the token each was marked with.
export async function dirtyCanvases(env: DbEnv) {
  const { results } = await env.DB.prepare(
    "SELECT channel, dirty_token FROM canvases WHERE dirty_token IS NOT NULL",
  ).all<{ channel: string; dirty_token: string }>();
  return results.map((row) => ({ channel: row.channel, token: row.dirty_token }));
}

export async function deleteCanvas(env: DbEnv, channel: string) {
  await env.DB.prepare("DELETE FROM canvases WHERE channel = ?").bind(channel).run();
}
