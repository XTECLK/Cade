# Agent video: Randil's AI agent finds the work

One take, one video: `mcp.mp4`, played in the "Bring your own agent" part of [the home page](../index.html).

**Randil** = the developer, with Claude Code connected to Cade (recorded screen) · **Udara** = the client
**Channel:** `#team` (an ordinary channel shared with the client, Cade in it)

Copy each 💬 line exactly. ▶️ = click/do. 👀 = show it on camera. 🤖 = what the agent does.

---

## ✅ Before recording

- [ ] Randil: Cade's Home tab → **Settings → AI agent** → make an API key, and connect Claude Code to Cade with it
- [ ] Randil: in Claude Code, `/mcp` shows **cade** connected
- [ ] Send the three discussions below in `#team` beforehand (not on camera)
- [ ] Screen layout: Claude Code on the left, Slack (`#team` and `#proj-dev`) on the right
- [ ] Larger terminal font, so the previews can be read in the video
- [ ] Resend the discussions for every retake (a thread already made into a task isn't listed again)

---

## 🌱 Seed: three discussions in `#team` (not recorded)

**Discussion 1: should become a task**

| Who | 💬 |
|---|---|
| **Udara** | (top-level) `Our accountant says the invoice PDFs are missing our VAT number. Can you add it?` |
| **Randil** | (reply) `Sure, it's already in the company settings, it's just not printed on the PDF` |
| **Udara** | `We need it before the month-end invoices go out, so by 30/11` |
| **Randil** | `No problem, I'll check how big the change is` |

**Discussion 2: an idea for later**

| Who | 💬 |
|---|---|
| **Udara** | (top-level) `Could we have a dark mode for the dashboard some day? Not urgent, just an idea` |
| **Randil** | (reply) `Nice idea, let's talk about it after the release` |
| **Udara** | `Sure 👍` |

**Discussion 3: just a thank-you**

| Who | 💬 |
|---|---|
| **Udara** | (top-level) `Thanks for the quick fix on the payments yesterday!` |
| **Randil** | (reply) `Happy to help 🙌` |

---

## 🎬 Scene 1: What's being discussed?

| # | Who | What |
|---|---|---|
| 1 | **Randil** | 💬 (Claude Code) `What's been discussed in #team in the last 3 days that isn't a task yet?` |
| 2 | 🤖 | `get_channels` → `get_channel_threads` (#team) |
| 3 | **Randil** | 👀 The three discussions, with who started each and how many replies |

## 🎬 Scene 2: Which should become tasks?

| # | Who | What |
|---|---|---|
| 1 | **Randil** | 💬 `Read them and tell me which ones should become tasks` |
| 2 | 🤖 | `get_thread_history` on each, `get_tasks` to check nothing is tracked already |
| 3 | **Randil** | 👀 Recommendation: the **VAT number on invoices** is a task (due 30/11); **dark mode** is an idea for after the release; the **thank-you** is not a task |

## 🎬 Scene 3: Create the task

| # | Who | What |
|---|---|---|
| 1 | **Randil** | 💬 `Create a task for the VAT number one` |
| 2 | 🤖 | Shows a preview and asks **"Go ahead?"**: kind task · title · project · priority · due 30/11/2026 · the whole summary · the thread it comes from |
| 3 | **Randil** | 👀 Pause on the preview: nothing is made without approval |
| 4 | **Randil** | 💬 `yes` |
| 5 | 🤖 | `create_task` → gives the task's link |
| 6 | **Randil** | 👀 Slack: the card in `#proj-dev`, marked as made by an AI agent; Udara's message is copied into its thread; `#team` shows 📤 and Cade's note |

## 🎬 Scene 4: "I'll work on it"

| # | Who | What |
|---|---|---|
| 1 | **Randil** | 💬 `Assign it to me and tell the thread I'll work on it` |
| 2 | 🤖 | Preview: owner none → Randil, and the message as it will be posted. Asks **"Go ahead?"** (and, if Claude Code has its own Slack tools, whether to send as Randil or via Cade) |
| 3 | **Randil** | 💬 `yes, via Cade` |
| 4 | 🤖 | `update_task` → `send_thread_message` |
| 5 | **Randil** | 👀 Slack, task thread: Cade notes Randil as owner, and Randil's message, ending with "(via AI agent)" |
| 6 *(optional)* | **Udara** | 💬 (in the task thread) `Thanks Randil!` |

---

## 🎞️ Edit and export

- Speed up the parts where the agent is thinking; keep the previews and the Slack results at normal speed.
- Captions, if you like: "What's being discussed?" · "Which should be tasks?" · "Nothing changes without your yes" · "Assigned, and the client told".

```
ffmpeg -i raw.mov -vf "scale=1600:-2" -c:v libx264 -crf 26 -preset slow -an -movflags +faststart mcp.mp4
```
