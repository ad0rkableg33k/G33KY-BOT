# xXOnlineStatusXx Channel Indexer Bot

Exports every channel in your server to `channels.json` and can post a
formatted, categorized index (name + clickable link + topic) into any
channel via a slash command. Also includes an optional, per-server
"cameras-on" voice channel policy.

This bot only **reads** channel info and **posts messages** (plus, if the
camera policy is turned on, disconnects people from voice who don't turn
their camera on in time) — it does not rename, delete, or edit any channel.

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
built-in channel Topic field, so nothing pulled from Discord (including any
messy pinned templates in a channel's topic) will ever show up here.

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
the DMs intrusive. Pinging in the voice channel's own text chat (the chat
panel built into every voice channel) keeps it visible in-context instead
of landing in someone's private messages.

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
needed. Requires **Manage Server** permission. Per-server — one server
switching it off never affects another. Turning it off immediately cancels
any reminders/countdowns currently in progress in that server.

### Choosing which voice channels to monitor

- `/camera-monitor add channel:#voice-chat`
- `/camera-monitor remove channel:#voice-chat`
- `/camera-monitor list`

### Exempting roles

For members who have legitimate reasons not to use a camera (anxiety,
privacy, etc.) — exempt roles never get a reminder or get moved, no matter
how long their camera's off.

- `/camera-exempt-role add role:@Camera Exempt`
- `/camera-exempt-role remove role:@Camera Exempt`
- `/camera-exempt-role list`

### Adjusting the timing

Defaults are 2 minutes (silent grace) + 3 minutes (after the reminder) = 5
minutes total before removal — matching the originally announced policy.
Adjustable per server:

- `/camera-timing set grace_minutes:2 warning_minutes:3`
- `/camera-timing view`

### Linking your policy announcement

If you've posted an announcement explaining the policy (like the original
xXOnlineStatusXx one), you can attach that link so it's automatically
included at the bottom of every reminder message:

- `/camera-announcement set url:https://discord.com/channels/...`
- `/camera-announcement clear`
- `/camera-announcement view`

### Multi-server notes

Every setting above (on/off, monitored channels, exempt roles, timing,
announcement link) is stored **per server** in `camera-config.json`,
keyed by server ID. A friend's server can set up and run its own
completely independent camera policy without touching any code or
affecting xXOnlineStatusXx's settings, and vice versa.

xXOnlineStatusXx's original hardcoded channel/role list was automatically
migrated into this file the first time this version ran, so nothing was
lost or reset.

### Important — Railway persistence

`camera-config.json`, `channels.json`, and `descriptions.json` all live on
local disk. Many hosting platforms (Railway included, by default) do NOT
persist local files across redeploys — meaning every code push could wipe
these files and reset to the seeded defaults, losing any settings servers
configured via slash commands since the last deploy. The fix is attaching
a Railway Volume (persistent disk) to the project. Ask Claude to walk
through this setup if it hasn't been done yet, or if configured settings
start disappearing after a push.

### Setting up a Railway Volume (do this before pushing the update above)

1. Open your project on Railway
2. Right-click empty space on the project canvas (or press `Cmd/Ctrl+K` for
   the command palette) and choose **"Create Volume"**
3. Attach it to your bot's service
4. Set the **mount path** to `/data`
5. Go to your service → **Variables** tab → add a new variable:
   - `DATA_DIR` = `/data`
6. Redeploy (Railway will usually do this automatically after adding the
   variable — check the Deployments tab)

From then on, `camera-config.json`, `channels.json`, and `descriptions.json`
will live on that persistent volume instead of the app's temporary
filesystem, so they survive every future code push.
