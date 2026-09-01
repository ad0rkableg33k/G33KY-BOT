# High-Speed Connection Bot
### (aka G33KY Bot)

A Discord community-management bot for servers that actually care about engagement. Camera policy enforcement, activity tracking, channel indexing, and automated speed-dating events — all configurable per-server via slash commands, no code edits needed.

---

## Setup

1. **Install Node.js** if you don't have it: https://nodejs.org (LTS version)

2. **Install dependencies**
   ```
   npm install
   ```

3. **Get your Server (Guild) ID**
   - In Discord, go to User Settings > Advanced > turn on Developer Mode
   - Right-click your server icon > Copy Server ID

4. **Fill in your `.env` file**
   - Copy `.env.example` to a new file named `.env`
   - Paste in your bot token (from the Discord Developer Portal > Bot > Token)
   - Paste in your Server ID
   - **Never share this `.env` file or commit it to GitHub** — it's already
     in `.gitignore` so a normal `git add .` won't pick it up

5. **Run it**
   ```
   node index.js
   ```
   On startup it will:
   - Log in
   - Register the slash commands globally (may take up to ~1hr to first
     appear after a change, then it's instant)
   - Write `channels.json` to this folder automatically

---

## Using it in Discord

- `/channel-index` — posts a categorized embed listing every channel with
  a clickable link. Add `category:General` to only list one category.
- `/export-channels` — re-exports and sends you `channels.json` directly
  in Discord (only visible to you).
- `/userinfo user:@someone` — shows profile info for any user, whether or
  not they're currently in the server. Pick them from the picker, or paste
  their raw user ID if they've left. Shows their account creation date,
  avatar, banner (if set), and — if they're still a member — nickname,
  join date, and roles too.

---

## Adding your own channel descriptions

The first time the bot runs, it creates a `descriptions.json` file in this
folder — pre-filled with every channel's name and ID, and an empty
`"description"` field for each. It will **never overwrite this file** once
it exists, so your edits are always safe.

To add descriptions:
1. Open `descriptions.json` in Notepad or VS Code
2. Fill in the `"description"` field for any channel you want a blurb on,
   e.g.:
   ```json
   "123456789012345678": {
     "name": "general",
     "description": "Main hangout chat for the whole server"
   }
   ```
3. Save the file
4. Run `/channel-index` again in Discord — no restart needed, it reads the
   file fresh every time

Channels left with an empty `""` description just show as `#channel-name`
with no blurb, same as before. This is completely separate from Discord's
built-in channel Topic field.

## Stopping the bot

`Ctrl+C` in the terminal. The bot only needs to run while you're actively
using the slash commands — it doesn't need to stay online 24/7 unless you
want the slash commands available any time.

---

## Cameras-On voice channel policy

A low-noise, two-stage system for encouraging active participation in
voice chat, fully configurable per-server via slash commands — no code
edits needed.

**How it works, by default:**
1. Someone joins a monitored voice channel (or turns their camera off
   while already in one) with no camera → a **silent 2-minute grace
   period** starts. Nothing is sent yet — this absorbs brief flickers,
   bad connections, or someone just settling in, without ever pinging them.
2. If the camera is still off after that → **one reminder** is posted
   right in the voice channel's own text chat (an `@mention`, not a DM),
   and a **3-minute** countdown starts.
3. If the camera is still off after that → they're **disconnected** from
   the voice channel, with a short follow-up message.
4. Turning the camera on at any point cancels everything for that cycle.
   A confirmation ("✅ Thanks for turning your camera on!") is only posted
   if a reminder had actually gone out — turning it on during the silent
   grace period is invisible, no message either way.
5. Turning the camera off again later starts a completely fresh cycle —
   full grace period, fresh reminder, fresh countdown.

**We switched from DMs to in-channel @pings** because members were finding
the DMs intrusive. Pinging in the voice channel's own text chat keeps it
visible in-context instead of landing in someone's private messages.

### This feature needs two things enabled that the rest of the bot didn't

1. **Server Members Intent** — a "privileged" intent Discord makes you
   turn on manually:
   - Discord Developer Portal → your bot → **Bot** page (left sidebar)
   - Scroll to **Privileged Gateway Intents**
   - Turn ON **"Server Members Intent"**
   - Save changes

2. **Move Members permission** — needed to disconnect someone from voice.
   If your bot's invite doesn't already include it:
   - Developer Portal → your bot → **OAuth2** → **URL Generator**
   - Scopes: `bot` and `applications.commands`
   - Bot Permissions: everything you already have, plus **Move Members**
   - Copy the new URL, open it, select your server, Authorize again
   - (Re-authorizing just updates the existing bot's permissions — no need
     to remove it first)

If you skip step 1, the bot fails to log in entirely with an intent error.
If you skip step 2, reminders send fine but removal silently fails (logged
in the terminal).

### Turning the policy on/off

`/camera-policy state:On` or `/camera-policy state:Off` — no restart
needed. Requires **Manage Server** permission. Per-server.

### Choosing which voice channels to monitor

- `/camera-monitor add channel:#voice-chat`
- `/camera-monitor remove channel:#voice-chat`
- `/camera-monitor list`

### Exempting roles

For members who have legitimate reasons not to use a camera (anxiety,
privacy, etc.) — exempt roles never get a reminder or get moved.

- `/camera-exempt-role add role:@Camera Exempt`
- `/camera-exempt-role remove role:@Camera Exempt`
- `/camera-exempt-role list`

### Adjusting the timing

Defaults are 2 minutes (silent grace) + 3 minutes (after the reminder) = 5
minutes total before removal. Adjustable per server:

- `/camera-timing set grace_minutes:2 warning_minutes:3`
- `/camera-timing view`

### Linking your policy announcement

- `/camera-announcement set url:https://discord.com/channels/...`
- `/camera-announcement clear`
- `/camera-announcement view`

### Multi-server notes

Every setting is stored **per server** in `camera-config.json`, keyed by
server ID. One server's configuration never affects another.

### Important — Railway persistence

`camera-config.json`, `channels.json`, and `descriptions.json` all live on
local disk. Many hosting platforms (Railway included, by default) do NOT
persist local files across redeploys. The fix is attaching a Railway Volume
to the project.

### Setting up a Railway Volume

1. Open your project on Railway
2. Right-click empty space on the project canvas and choose **"Create Volume"**
3. Attach it to your bot's service
4. Set the **mount path** to `/data`
5. Go to your service → **Variables** tab → add: `DATA_DIR` = `/data`
6. Redeploy

From then on, config files will live on that persistent volume and survive
every future code push.

---

## Legal

- [Terms of Service](https://ad0rkableg33k.github.io/G33KY-BOT/tos.html)
- [Privacy Policy](https://ad0rkableg33k.github.io/G33KY-BOT/privacy.html)
- Contact: dragon.exe@atomicmail.io
