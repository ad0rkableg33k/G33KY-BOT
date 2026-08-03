# xXOnlineStatusXx Channel Indexer Bot

Exports every channel in your server to `channels.json` and can post a
formatted, categorized index (name + clickable link + topic) into any
channel via a slash command.

This bot only **reads** channel info and **posts messages** — it does
not rename, delete, or edit any channel. (Manage Channels permission is
granted on the invite for future use, but nothing in this script uses it.)

## Setup

1. **Install Node.js** if you don't have it: https://nodejs.org (LTS version)

2. **Install dependencies**
   ```
   npm install
   ```

3. **Get your Server (Guild) ID**
   - In Discord, go to User Settings > Advanced > turn on Developer Mode
   - Right-click your server icon (xXOnlineStatusXx) > Copy Server ID

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
   - Register the slash commands to your server (instant, not the ~1hr
     delay you get with global commands)
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

## Customizing further

## Stopping the bot

`Ctrl+C` in the terminal. The bot only needs to run while you're actively
using the slash commands — it doesn't need to stay online 24/7 unless you
want the slash commands available any time.

## Cameras-On voice channel policy

The bot enforces a "camera must be on" rule in specific voice channels.
If someone joins one of those channels (or turns their camera off while
already in one), the bot DMs them a warning. If they don't turn their
camera on within 5 minutes, they get moved out of the channel automatically.
The monitored channel IDs are hard-coded near the top of `index.js` in
`CAMERA_ON_CHANNEL_IDS` — edit that list directly to add or remove channels.

**This feature needs two things enabled that the rest of the bot didn't:**

1. **Server Members Intent** — this is a "privileged" intent Discord makes
   you turn on manually:
   - Go to the Discord Developer Portal
   - Your bot -> **Bot** page (left sidebar)
   - Scroll to **Privileged Gateway Intents**
   - Turn ON **"Server Members Intent"**
   - Save changes

2. **Move Members permission** — the original bot invite didn't include
   this, so you'll need to re-invite the bot with it added:
   - Developer Portal -> your bot -> **OAuth2** -> **URL Generator**
   - Scopes: `bot` and `applications.commands` (same as before)
   - Bot Permissions: keep everything checked from before, and additionally
     check **Move Members**
   - Copy the new URL, open it, select xXOnlineStatusXx, Authorize again
   - (Re-authorizing just updates the existing bot's permissions — no need
     to remove it first)

If you skip step 1, the bot will fail to log in at all with an intent
error. If you skip step 2, it'll DM the warning fine but fail (silently
logged in the terminal) when it tries to actually move someone out.

### Turning the policy on/off

Use `/camera-policy state:Off` or `/camera-policy state:On` right in Discord
— no restart needed. Only people with **Manage Server** permission can use
this command. The setting is saved to `camera-policy-state.json` so it
sticks even through a bot restart (e.g. a Railway redeploy won't silently
turn it back on if you'd switched it off). Turning it off also immediately
cancels any warnings currently in progress, so nobody gets moved out after
the fact.

### Exempting roles from the camera policy

Members with a role listed in `CAMERA_EXEMPT_ROLE_IDS` (near the top of
`index.js`) skip the cameras-on enforcement entirely, no matter what channel
they're in. To exempt a role: Server Settings -> Roles -> click the role ->
there's a "Copy Role ID" option (or right-click the role in the member list
sidebar) -> send the ID to Claude, or paste it directly into the list in
`index.js`. No new Discord permissions are needed for this — it's a
code-only change.

### Anti-spam safeguard

If someone rapidly toggles their camera off/on/off, the bot won't send a
fresh DM warning every single time — only once per minute
(`CAMERA_REWARN_COOLDOWN_MS` near the top of `index.js`, adjustable). It
still silently tracks and enforces the policy underneath, though — if they
genuinely leave the camera off, they'll still get moved out on schedule,
they just won't get spammed with a new DM for every quick flicker.
