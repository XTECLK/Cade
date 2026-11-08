# Demo video: Randil (developer) and Udara (client)

One take, cut into one video: `demo.mp4`, played at the top of [the home page](../index.html).

**Randil** = the developer, **recorded screen** · **Udara** = the client, who also reviews and approves (second screen)
**Channels:** `#team` (an ordinary channel shared with the client, Cade in it) · `#proj-dev` (the project's dev channel, both in it)

Copy each 💬 line exactly. ▶️ = click/do. 👀 = show it on camera. 🙈 = happens on Udara's screen, off camera.

---

## ✅ Before recording

- [ ] Both accounts: Cade's Home tab → **Settings → Suggestions** is **on**
- [ ] Both windows open on `#team` and `#proj-dev`
- [ ] A real PR link ready for Scene 4
- [ ] Never click **Reject** during a take (3 rejects in a row and Cade offers to turn suggestions off)
- [ ] Suggestions and buttons are private: they only show to **whoever wrote the message**. The script has Randil write the messages Cade acts on, so they show on the recorded screen
- [ ] Fresh messages for every retake (a message already moved gives "Sorry, that didn't work")
- [ ] 1080p, Slack zoom ~110%, unrelated channels hidden
- [ ] Pause about a second after each click so Cade's reply lands

**What Cade's replies look like:**
- A typed command (`@Cade status …`) gets a ✅ on your message.
- **Accept** on a suggestion posts one message in the thread: what changed, then what it asks of the people it names.
- A suggestion reads "Should I update the task? From your message: …" with **Accept · Edit… · Reject**.

---

## 🎬 Scene 1: The client asks in #team → task

**Where:** `#team`

| # | Who | What |
|---|---|---|
| 1 | **Udara** | 💬 (top-level) `Hi Randil, a few of our customers said the booking page takes ages to load on mobile. Can you check?` |
| 2 | **Randil** | 💬 (reply in thread) `Sure. Looks like the hotel images load full size, some are 4–5 MB each` |
| 3 | **Udara** | 💬 `That would explain it. Can you make them smaller without losing quality?` |
| 4 | **Randil** | 💬 `Yes, Cloudflare Images can resize them on the fly, so the old ones don't need reprocessing` |
| 5 | **Udara** | 💬 `Sounds good. Could the gallery load faster too?` |
| 6 | **Randil** | 💬 `I'll lazy-load it, so only the first image loads straight away. About two days of work` |
| 7 | **Udara** | 💬 `Great, please go ahead 👍` |
| 8 | **Randil** | ▶️ Hover the **first** message → ⋯ → **More actions → New task** |
| 9 | **Randil** | ▶️ Title `Speed up booking page on mobile` · Priority **High** → **Create** |
| 10 | **Randil** | 👀 Card in `#proj-dev` → open its thread (message copied in) → back to `#team`: 📤 + Cade's note |

> The task's thread gets only the first message. The replies stay in `#team`, and the copy links back to them (Scene 5 uses this).

---

## 🎬 Scene 2: A discussion in the dev channel → `@Cade task`

**Where:** `#proj-dev`

| # | Who | What |
|---|---|---|
| 1 | **Randil** | 💬 (top-level) `Login emails are going to spam for Gmail users` |
| 2 | **Randil** | 👀 Cade's private question (New task / New incident / Move / Not now) ▶️ **Not now** |
| 3 | **Udara** | 💬 (reply in thread) `Yes, our users are complaining too. Since when?` |
| 4 | **Randil** | 💬 `Since the domain move last week. I think SPF and DKIM aren't set up for the new domain` |
| 5 | **Udara** | 💬 `Can you fix it this week?` |
| 6 | **Randil** | 💬 `Yes, DKIM is missing. It needs a DNS change plus a fix in the mail service config` |
| 7 | **Randil** | 💬 `@Cade task` |
| 8 | **Randil** | ▶️ Private button → form (already named) → **Medium** → **Create** |
| 9 | **Randil** | 👀 The message moved into the new task's thread |

---

## 🎬 Scene 3: Incident straight from a command

| # | Who | What |
|---|---|---|
| 1 | **Udara** | 💬 (in `#team`) `Urgent! Card payments are failing at checkout for our EU customers` |
| 2 | **Randil** | 💬 (in `#proj-dev`, top level, not in a thread) `/cade incident` |
| 3 | **Randil** | ▶️ Form: `Card payments failing at checkout for EU customers` → submit |
| 4 | **Randil** | 👀 Card says **Incident** · 🔴 Urgent · due Immediate |
| 5 | **Randil** | 💬 (in the incident thread) `@Cade assign owner @Randil` |
| 6 | **Randil** | 👀 ✅ on the command; the card shows Randil as owner |
| 7 | **Randil** | 💬 `on it` |
| 8 | **Randil** | 👀 Suggests **In progress** ▶️ **Accept** |
| 9 | **Randil** | 💬 `Found it, last night's deploy broke the EU payment provider config. Rolling back now` |
| 10 | **Randil** | 💬 `Done, rolled back and payments are going through again` |
| 11 | **Randil** | 👀 Suggests **Done** ▶️ **Accept** |
| 12 | **Udara** | 💬 `Confirmed, payments are working on our side. Thanks!` |
| 13 *(optional)* | **Randil** | 💬 `@Cade priority low` → 👀 Cade refuses: incidents stay Urgent |

---

## 🎬 Scene 4: Task thread, review and client approval

**Where:** the thread of **"Speed up booking page on mobile"** (Scene 1)

| # | Who | What |
|---|---|---|
| 1 | **Udara** | 💬 `We need this by Friday, it's blocking our release` |
| 2 | **Randil** | 💬 `Sure, I'll take this and have it done by Friday. Starting with the image resizing` |
| 3 | **Randil** | 👀 One summary: Owner @Randil · Due Friday · In progress. ▶️ Open **Edit…** briefly, close, then ▶️ **Accept** |
| 4 | **Randil** | 💬 `First pass is up: <PR LINK> @Udara can you review this?` |
| 5 | **Randil** | 👀 PR linked · Reviewer @Udara · **In review** ▶️ **Accept** |
| 6 | **Udara** | 💬 `lgtm, approved the PR` |
| 7 | **Udara** | 🙈 Suggests the next status ▶️ **Accept** |
| 8 | **Randil** | 👀 The change appears in the thread |
| 9 | **Randil** | 💬 `@Cade status client review` |
| 10 | **Randil** | 👀 Private **Ask for approval** button ▶️ click → pick **Udara** → send |
| 11 | **Randil** | 👀 Approval request in the thread with **Approve** / **Not approve** (only Udara can click) |
| 12 | **Udara** | 🙈 ▶️ **Approve** |
| 13 | **Randil** | 👀 Task goes to **Done**; the card shows owner Randil, reviewer Udara, the PR and the due date |

> If step 3 doesn't pick up Randil as owner, use `@Cade assign owner @Randil` and carry on.
> If the Ask for approval button is missed, send `@Cade status client review` again to get it back.

---

## 🎬 Scene 5 (optional): Randil's AI agent

| # | Who | What |
|---|---|---|
| 1 | **Randil** | 👀 After Scene 1, Cade's private message with a prompt: *"Summarize the Cade task … and save the summary once I approve it."* ▶️ Copy it |
| 2 | **Randil** | ▶️ Paste into Claude Code (Cade connected) |
| 3 | **Randil** | 👀 Agent reads the `#team` discussion through the link → shows a preview → asks "Go ahead?" |
| 4 | **Randil** | 💬 `yes` |
| 5 | **Randil** | 👀 Task thread says the summary was updated |

---

## 🎞️ Edit and export

- Cut the scenes into one video, with a thin caption bar if you like. No audio needed.
- Export (aim for a small file so the page loads quickly), and save a still as `demo.jpg`:

```
ffmpeg -i raw.mov -vf "scale=1600:-2" -c:v libx264 -crf 26 -preset slow -an -movflags +faststart demo.mp4
```
