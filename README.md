# LNS Channel Indexer Bot

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
   - Right-click your server icon (Late Night Society) > Copy Server ID

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
