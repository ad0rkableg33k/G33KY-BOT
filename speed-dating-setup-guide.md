# 💨・ʜɪɢʜ－sᴘᴇᴇᴅ・ᴄᴏɴɴᴇᴄᴛɪᴏɴ｜sᴇᴛᴜᴘ・ɢᴜɪᴅᴇ \& ʀᴜʟᴇs

\---

## Server Owner / Admin Setup (Step-by-Step)

### Before You Run the Event

**1. Invite the bot with the right permissions**
The bot needs these server-level permissions:

* Manage Roles
* Manage Channels
* Move Members
* View Channels
* Send Messages
* Read Message History
* Embed Links

> If you're using channel-specific permission overrides, the bot's role must sit \*\*above\*\* the Participant role in the role hierarchy or it won't be able to assign/remove it.

\---

**2. Open the bot dashboard → ʜɪɢʜ－sᴘᴇᴇᴅ・ᴄᴏɴɴᴇᴄᴛɪᴏɴ**
Navigate to `/vc-shuffle` in the bot dashboard.

\---

**3. Configure Roles (do this first)**

In the **Roles** card:

|Field|What to set|
|-|-|
|**Participant Role**|Create a new role (e.g. `participant`) — members get this when they join the lobby. All temp rooms are locked to this role.|
|**Bot Role**|The bot's own managed role — grant it View Channel, Connect, Move Members, Manage Channels on the event category.|
|**Staff Roles**|Any mod/admin roles that should be able to see and enter all rooms during the event.|

\---

**4. Click "🏗️ Create Event Channels"**

This creates the full channel structure automatically:

|Channel|Who sees it|Purpose|
|-|-|-|
|`#💨・ʜɪɢʜ－sᴘᴇᴇᴅ・ᴄᴏɴɴᴇᴄᴛɪᴏɴ｜ɪɴꜰᴏ`|Everyone with Participant role|Read-only how-it-works post|
|`#💨・ʜɪɢʜ－sᴘᴇᴇᴅ・ᴄᴏɴɴᴇᴄᴛɪᴏɴ｜ᴍᴀᴛᴄʜ-ᴜᴘs `|Everyone with Participant role|Round pairings + session summary after|
|`#💨・ʜɪɢʜ－sᴘᴇᴇᴅ・ᴄᴏɴɴᴇᴄᴛɪᴏɴ｜ᴄᴏɴᴛʀᴏʟ `|Staff only|Live control panel with buttons|
|`💨・ʜɪɢʜ－sᴘᴇᴇᴅ・ᴄᴏɴɴᴇᴄᴛɪᴏɴ｜ʟᴏʙʙʏ` (voice)|Participant role|Members wait here before each round|

> ⚠️ Set up your roles \*\*before\*\* running setup — channel permissions are built from those values at creation time.

\---

**5. Configure Round Settings**

In the **Settings** card:

|Setting|Recommended|Notes|
|-|-|-|
|Round length|3–5 minutes|Set min and max to the same value for a fixed timer|
|Warning before bell|30 seconds|Members get a heads-up before rotation|
|Mode|1-on-1|Classic speed connetion. 2v2 or 3v3 also available.|

\---

**6. Make the Participant Role Joinable**
Members need to get the Participant role to see the event channels. Options:

* Use a reaction role or button role bot to let members self-assign it
* Staff manually assign it before the event
* The bot auto-assigns it the moment someone joins the lobby (they just need to be able to see and join the lobby first)

For the lobby to be visible to members who don't have the role yet, you'll need to either:

* Make the category visible to `@everyone` with connect disabled (members can see it but can't enter without the role), or
* Have a separate "get the role first" flow, then they'll see the category

\---

**7. Run the Event**

On event day:

1. Open `#💨・ʜɪɢʜ－sᴘᴇᴇᴅ・ᴄᴏɴɴᴇᴄᴛɪᴏɴ｜ᴄᴏɴᴛʀᴏʟ`
2. Hit **▶️ Start** — the bot will run the first round immediately and schedule the rest
3. Use **🔔 Ring Bell** to manually rotate early if needed (resets the timer)
4. Use **⏹️ End Session** when done — posts the session summary to `#💨・ʜɪɢʜ－sᴘᴇᴇᴅ・ᴄᴏɴɴᴇᴄᴛɪᴏɴ｜ᴍᴀᴛᴄʜ-ᴜᴘs` and cleans up all temp rooms

\---

## Event Rules (post these in #💨・ʜɪɢʜ－sᴘᴇᴇᴅ・ᴄᴏɴɴᴇᴄᴛɪᴏɴ｜ɪɴꜰᴏ or your rules channel)

```
#💨・ʜɪɢʜ－sᴘᴇᴇᴅ・ᴄᴏɴɴᴇᴄᴛɪᴏɴ｜ʀᴜʟᴇs

1. Be respectful. This is a social event — treat everyone with basic human decency. 
   Harassment, hate speech, or anything that would get you kicked under the server rules 
   applies here too, doubly so.

2. Camera optional, but encouraged. The event works without video, but turning your 
   camera on makes it way more fun. If your camera cuts out after being moved to a new room, 
   just toggle it off and back on — it's a Discord bug, not you.

3. Stay in the lobby between rounds. Don't leave the voice channels between rounds — 
   the bot can only pair you if you're in the lobby when the round starts.

4. No pairing manipulation. Don't coordinate with friends to try to get paired together. 
   The whole point is to meet new people.

5. Keep it PG-13 in the rooms. Private conversations are private, but staff can enter 
   any room at any time. Act accordingly.

6. Leaving mid-round is fine. Life happens. You won't break anything — the bot handles 
   odd numbers by merging someone into a trio rather than leaving anyone alone.

7. One session = one set of pairings. The bot tracks who you've already been paired with 
   and avoids repeats for the entire session. If you've met everyone... you'll still rotate, 
   just with people you've already talked to.
```

\---

## Required Bot Permissions (Quick Reference)

|Permission|Why|
|-|-|
|Manage Roles|Assign/remove Participant role|
|Manage Channels|Create/delete temp voice rooms|
|Move Members|Move people between voice channels|
|View Channel|See all event channels|
|Send Messages|Post round announcements, bell messages, summaries|
|Read Message History|Edit/update the staff panel message|
|Embed Links|Post formatted embeds|

\---

## Troubleshooting

**Members can't see the event channels**
→ Check that the Participant role has View Channel permission on the event category. Make sure the role hierarchy has Participant role below the bot's role.

**Bot can't move members**
→ The bot role needs to be above the members' highest role in the hierarchy *and* have Move Members permission in the category.

**Staff panel buttons do nothing**
→ Make sure the staff roles are configured in the Roles card. Button access checks for Manage Guild permission OR one of the configured staff roles.

**Camera drops on move**
→ Discord client bug. Add a reminder to the bell messages or the info channel. Tell members to toggle video off → on after each rotation.

**Odd numbers pairing weirdly**
→ Working as intended. With 5 people: two pairs of 2, the fifth person gets added to the last pair as a trio. Nobody sits out.

