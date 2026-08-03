// LNS Channel Indexer Bot
// - Exports every channel in the server to channels.json
// - Registers a /channel-index slash command that posts a formatted
//   list of channels (name + link) into whatever channel it's run in
//
// This script does NOT rename, delete, or modify any channels.
// It only reads channel info and posts messages.

require('dotenv').config();
const fs = require('fs');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ChannelType,
} = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID; // your server ID

if (!TOKEN || !GUILD_ID) {
  console.error('Missing DISCORD_TOKEN or GUILD_ID in your .env file.');
  process.exit(1);
}

// ---- Cameras-On policy config ----
// Voice channels where members must have their camera on. Grabbed by
// right-clicking each voice channel -> Copy Channel ID.
const CAMERA_ON_CHANNEL_IDS = [
  '1492754497305575524',
  '1508940784764846165',
  '1519414974882119871',
  '1519926109192458330',
  '1497494159391588443',
  '1511860830612881538',
  '1519415207884226643',
  '1533720010835493016',
  '1529786928453390526',
  '1491289314053587045',
  '1491289471596101692',
  '1491289586201006084',
];
const CAMERA_WARNING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Members with ANY of these roles are exempt from the cameras-on policy
// entirely — they can be in a monitored channel with camera off and never
// get warned or moved. Right-click a role in Server Settings -> Roles
// (or right-click a member and check their roles) to grab a role's ID.
const CAMERA_EXEMPT_ROLE_IDS = [
  '1522494914255126559',
  '1491315204162850858',
];
const warnedUsers = new Map(); // userId -> { timeoutId, warningMessage }

// Whether the Cameras-On policy is currently active. Persisted to a small
// file so a restart (e.g. a Railway redeploy) doesn't silently turn it back
// on if you'd switched it off.
const CAMERA_POLICY_STATE_FILE = 'camera-policy-state.json';

function loadCameraPolicyEnabled() {
  try {
    const raw = fs.readFileSync(CAMERA_POLICY_STATE_FILE, 'utf-8');
    return JSON.parse(raw).enabled;
  } catch {
    return true; // default: on, if no state file exists yet
  }
}

function saveCameraPolicyEnabled(enabled) {
  fs.writeFileSync(CAMERA_POLICY_STATE_FILE, JSON.stringify({ enabled }, null, 2));
}

let cameraPolicyEnabled = loadCameraPolicyEnabled();

// GuildMembers is a PRIVILEGED intent — you must turn it on for this bot
// in the Discord Developer Portal (Bot page -> Privileged Gateway Intents
// -> Server Members Intent) or the bot will fail to log in with this intent
// enabled here.
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers],
});

// Categories to always leave out of /channel-index posts — matched by ID,
// not name, since stylized/fancy-font category names don't reliably match
// by text (lookalike Unicode characters aren't the same as plain letters).
// To exclude a category: right-click it in Discord -> Copy Channel ID ->
// paste the ID here as a string.
const EXCLUDED_CATEGORY_IDS = [
  '1517124026756235294', // ✦ ₊ ˚ xX☆ѕтαƒƒ ѕтuƒƒ☆Xx ˚ ₊ ✦
  '1494265392338702377',
  '1522368511123525754',
  '1522167743237984336',
];

// Individual channels to always leave out, matched by exact channel ID.
// Use this for one-off channels (right-click the channel -> Copy Channel ID).
const EXCLUDED_CHANNEL_IDS = [
  '1533592609623376095',
  '1521265292070752286',
];

// Individual channels to always leave out, matched by a keyword anywhere
// in the channel's name (case-insensitive) — regardless of what category
// they're in. Covers things like ticket-0069, ticket-0071, etc.
const EXCLUDED_NAME_KEYWORDS = ['ticket'];

// Human-readable names for Discord's channel type numbers
const CHANNEL_TYPE_NAMES = {
  [ChannelType.GuildText]: 'text',
  [ChannelType.GuildVoice]: 'voice',
  [ChannelType.GuildCategory]: 'category',
  [ChannelType.GuildAnnouncement]: 'announcement',
  [ChannelType.GuildForum]: 'forum',
  [ChannelType.GuildStageVoice]: 'stage',
  [ChannelType.GuildMedia]: 'media',
};

// ---- Slash command definitions ----
const commands = [
  new SlashCommandBuilder()
    .setName('channel-index')
    .setDescription('Post a formatted index of all channels in this server')
    .addStringOption((opt) =>
      opt
        .setName('category')
        .setDescription('Only list channels in this category (optional)')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('export-channels')
    .setDescription('Export all channels to a channels.json file (posted here as a file)'),
  new SlashCommandBuilder()
    .setName('userinfo')
    .setDescription('Show whatever profile info is available for a user, even if they left the server')
    .addUserOption((opt) =>
      opt
        .setName('user')
        .setDescription('The user to look up (pick from list or paste their ID)')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('camera-policy')
    .setDescription('Turn the cameras-on voice channel policy on or off')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) =>
      opt
        .setName('state')
        .setDescription('Turn the policy on or off')
        .setRequired(true)
        .addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' })
    ),
].map((cmd) => cmd.toJSON());

// ---- Register slash commands with Discord (guild-scoped = instant, not global) ----
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), {
    body: commands,
  });
  console.log('Slash commands registered.');
}

// ---- Build the channel list data ----
function getChannelData(guild, categoryFilter = null) {
  const channels = guild.channels.cache
    .filter((ch) => ch.type !== ChannelType.GuildCategory)
    .filter((ch) => {
      if (!categoryFilter) return true;
      return ch.parent?.name?.toLowerCase() === categoryFilter.toLowerCase();
    })
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map((ch) => ({
      name: ch.name,
      id: ch.id,
      type: CHANNEL_TYPE_NAMES[ch.type] || 'unknown',
      category: ch.parent ? ch.parent.name : null,
      categoryId: ch.parentId || null,
      link: `https://discord.com/channels/${guild.id}/${ch.id}`,
      topic: ch.topic || null, // channel's own "topic" description, if set
    }));
  return channels;
}

// ---- Export to local channels.json ----
function exportToFile(guild) {
  const data = getChannelData(guild);
  fs.writeFileSync('channels.json', JSON.stringify(data, null, 2));
  console.log(`Wrote ${data.length} channels to channels.json`);
  return data;
}

// ---- descriptions.json: hand-maintained channel descriptions ----
// Keyed by channel ID (not name) so two channels that happen to share a
// name in different categories never collide. Each entry also stores the
// channel's current name so the file stays readable when you're editing it
// by hand — you can see at a glance which ID belongs to which channel.
const DESCRIPTIONS_FILE = 'descriptions.json';

function ensureDescriptionsFile(guild) {
  if (fs.existsSync(DESCRIPTIONS_FILE)) return; // never overwrite your edits

  const data = getChannelData(guild);
  const template = {};
  for (const ch of data) {
    template[ch.id] = { name: ch.name, description: '' };
  }
  fs.writeFileSync(DESCRIPTIONS_FILE, JSON.stringify(template, null, 2));
  console.log(`Created ${DESCRIPTIONS_FILE} — fill in the "description" fields whenever you're ready.`);
}

function loadDescriptions() {
  try {
    const raw = fs.readFileSync(DESCRIPTIONS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {}; // file missing or invalid — just proceed without descriptions
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();

  // Also do a one-time export to file on startup, so you get channels.json
  // immediately without needing to run a slash command first.
  const guild = await client.guilds.fetch(GUILD_ID);
  exportToFile(guild);
  ensureDescriptionsFile(guild);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const receivedAt = Date.now();
  const interactionAge = receivedAt - interaction.createdTimestamp;
  console.log(`[timing] Interaction received. Age when handler started: ${interactionAge}ms`);

  try {
    if (interaction.commandName === 'export-channels') {
      await interaction.deferReply({ ephemeral: true });
      const data = exportToFile(interaction.guild);
      await interaction.editReply({
        content: `Exported ${data.length} channels.`,
        files: ['channels.json'],
      });
    }

    if (interaction.commandName === 'userinfo') {
      await interaction.deferReply();
      const targetUser = interaction.options.getUser('user');

      // force:true skips the cache so we get the FULL profile — banner,
      // accent color, etc — not just the stripped-down version Discord
      // sends over the gateway for users who aren't in the server.
      const fullUser = await client.users.fetch(targetUser.id, { force: true });

      // Try to get guild-specific info (nickname, roles, join date).
      // This will simply fail if the user isn't in the server — that's
      // expected and fine, we just show less info in that case.
      let member = null;
      try {
        member = await interaction.guild.members.fetch(targetUser.id);
      } catch {
        member = null;
      }

      const embed = new EmbedBuilder()
        .setColor(member?.displayHexColor && member.displayHexColor !== '#000000' ? member.displayHexColor : 0x8a2be2)
        .setTitle(fullUser.username)
        .setThumbnail(fullUser.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: 'User ID', value: fullUser.id, inline: true },
          { name: 'Display Name', value: fullUser.globalName || fullUser.username, inline: true },
          { name: 'Bot Account', value: fullUser.bot ? 'Yes' : 'No', inline: true },
          { name: 'Account Created', value: `<t:${Math.floor(fullUser.createdTimestamp / 1000)}:F>`, inline: false }
        )
        .setTimestamp();

      if (fullUser.banner) {
        embed.setImage(fullUser.bannerURL({ size: 512 }));
      }

      if (member) {
        embed.addFields(
          { name: 'In This Server', value: 'Yes', inline: true },
          { name: 'Nickname', value: member.nickname || '—', inline: true },
          { name: 'Joined Server', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:F>`, inline: false }
        );
        const roles = member.roles.cache
          .filter((r) => r.id !== interaction.guild.id) // exclude @everyone
          .map((r) => r.name);
        if (roles.length) {
          embed.addFields({ name: `Roles (${roles.length})`, value: roles.join(', ').slice(0, 1024) });
        }
      } else {
        embed.addFields({ name: 'In This Server', value: 'No — showing global profile only', inline: true });
      }

      await interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === 'camera-policy') {
      const desiredState = interaction.options.getString('state'); // 'on' or 'off'
      cameraPolicyEnabled = desiredState === 'on';
      saveCameraPolicyEnabled(cameraPolicyEnabled);

      if (!cameraPolicyEnabled) {
        // Clear any warnings currently in flight so nobody gets moved out
        // after the policy's been switched off
        for (const [memberId, info] of warnedUsers.entries()) {
          clearTimeout(info.timeoutId);
        }
        warnedUsers.clear();
      }

      await interaction.reply({
        content: cameraPolicyEnabled
          ? '📷 Cameras-on policy is now **ON** — camera required in monitored voice channels.'
          : '📴 Cameras-on policy is now **OFF** — no camera enforcement until turned back on.',
        ephemeral: false,
      });
    }

    if (interaction.commandName === 'channel-index') {
      await interaction.deferReply();
      const categoryFilter = interaction.options.getString('category');
      const data = getChannelData(interaction.guild, categoryFilter);

      // Group by category for a clean, readable post — skipping any
      // categories in EXCLUDED_CATEGORY_IDS, and any individual channels
      // whose name contains a keyword from EXCLUDED_NAME_KEYWORDS (e.g. tickets).
      const byCategory = {};
      for (const ch of data) {
        if (ch.categoryId && EXCLUDED_CATEGORY_IDS.includes(ch.categoryId)) continue;
        if (EXCLUDED_CHANNEL_IDS.includes(ch.id)) continue;
        const nameLower = ch.name.toLowerCase();
        if (EXCLUDED_NAME_KEYWORDS.some((kw) => nameLower.includes(kw))) continue;

        const key = ch.category || 'No Category';
        if (!byCategory[key]) byCategory[key] = [];
        byCategory[key].push(ch);
      }


      // Discord's 6000-character limit applies to the COMBINED total across
      // all embeds within a single message (not per-embed). To sidestep that
      // entirely, we send one embed per message — each message gets its own
      // fresh 6000-char and 25-field budget, so there's no cross-embed math
      // to get wrong. With 144+ channels this just means several messages
      // posted back to back, which is fine for an index.
      const MAX_FIELDS_PER_EMBED = 25;
      const MAX_CHARS_PER_EMBED = 5500; // buffer under Discord's 6000 limit

      const descriptions = loadDescriptions();

      const categoryEntries = Object.entries(byCategory);
      const embeds = [];
      let current = null;
      let fieldCount = 0;
      let charCount = 0;
      let isFirstEmbed = true;

      const startNewEmbed = () => {
        const e = new EmbedBuilder().setColor(0x8a2be2);
        if (isFirstEmbed) {
          e.setTitle(categoryFilter ? `Channel Index — ${categoryFilter}` : 'Channel Index').setTimestamp();
          isFirstEmbed = false;
        }
        return e;
      };
      current = startNewEmbed();

      for (const [category, chans] of categoryEntries) {
        const lines = chans.map((ch) => {
          const desc = descriptions[ch.id]?.description?.trim();
          const label = desc ? `**#${ch.name}** — ${desc}` : `**#${ch.name}**`;
          return `[${label}](${ch.link})`;
        });
        const value = lines.join('\n').slice(0, 1024) || '—';
        const entryChars = category.length + value.length;

        const needsNewEmbed = fieldCount >= MAX_FIELDS_PER_EMBED || charCount + entryChars > MAX_CHARS_PER_EMBED;
        if (needsNewEmbed) {
          embeds.push(current);
          current = startNewEmbed();
          fieldCount = 0;
          charCount = 0;
        }

        current.addFields({ name: category, value });
        fieldCount++;
        charCount += entryChars;
      }
      embeds.push(current);

      // Send first embed as the actual reply, the rest as separate follow-up messages
      await interaction.editReply({ embeds: [embeds[0]] });
      for (let i = 1; i < embeds.length; i++) {
        await interaction.followUp({ embeds: [embeds[i]] });
      }
    }
  } catch (err) {
    console.error('Error handling interaction:', err);
    // Try to let the user know something went wrong, without crashing the bot
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('Something went wrong running that command — check the terminal for details.');
      } else {
        await interaction.reply({
          content: 'Something went wrong running that command — check the terminal for details.',
          ephemeral: true,
        });
      }
    } catch (followUpErr) {
      // If we can't even respond (e.g. interaction expired), just log and move on
      console.error('Could not send error response to Discord:', followUpErr.message);
    }
  }
});

// ---- Cameras-On voice channel policy ----
async function handleCameraOff(member, channel) {
  // Don't double-warn someone who's already got an active warning running
  if (warnedUsers.has(member.id)) return;

  try {
    const minutes = Math.round(CAMERA_WARNING_TIMEOUT_MS / 60000);
    const warningMessage = await member.send(
      `📷 Please enable your camera in **${channel.name}** within the next ${minutes} minute(s), or you'll be moved out of the channel.`
    );

    const timeoutId = setTimeout(async () => {
      try {
        // Re-check current voice state right before acting — they may have
        // left the channel entirely, or moved elsewhere, since the warning fired
        const currentVoiceChannel = member.voice?.channel;
        const stillInMonitoredChannel = currentVoiceChannel && CAMERA_ON_CHANNEL_IDS.includes(currentVoiceChannel.id);

        if (stillInMonitoredChannel && !member.voice.selfVideo) {
          await member.voice.disconnect('Camera not enabled within the warning period');
          await member.send(`❌ You were moved out of **${channel.name}** for not enabling your camera. Feel free to rejoin with your camera on!`);
        }
      } catch (err) {
        console.error('Error enforcing camera-off timeout:', err.message);
      } finally {
        warnedUsers.delete(member.id);
      }
    }, CAMERA_WARNING_TIMEOUT_MS);

    warnedUsers.set(member.id, { timeoutId, warningMessage });
  } catch (err) {
    // Most common cause: the member has DMs closed to non-friends
    console.error(`Could not DM ${member.user.tag} about camera policy:`, err.message);
  }
}

async function clearWarning(memberId) {
  const info = warnedUsers.get(memberId);
  if (!info) return;

  clearTimeout(info.timeoutId);
  warnedUsers.delete(memberId);

  try {
    await info.warningMessage.edit('✅ Thanks for turning your camera on!');
  } catch (err) {
    console.error('Could not edit warning message:', err.message);
  }
}

client.on('voiceStateUpdate', async (oldState, newState) => {
  if (!cameraPolicyEnabled) return;

  const channelId = newState.channelId;
  if (!channelId || !CAMERA_ON_CHANNEL_IDS.includes(channelId)) {
    // They're not in (or just left) a monitored channel — if they had an
    // active warning running, clear it so it doesn't fire after they've left
    if (!newState.channelId && warnedUsers.has(newState.member.id)) {
      clearWarning(newState.member.id);
    }
    return;
  }

  const member = newState.member;
  const channel = newState.channel;
  const cameraIsOn = newState.selfVideo;

  const isExempt = member.roles.cache.some((role) => CAMERA_EXEMPT_ROLE_IDS.includes(role.id));
  if (isExempt) {
    // Exempt members never get warned — but if they were already mid-warning
    // (e.g. a role was just added to them), clear it so it doesn't still fire
    if (warnedUsers.has(member.id)) await clearWarning(member.id);
    return;
  }

  if (!cameraIsOn) {
    // Either just joined with camera off, or was already in and turned it off
    await handleCameraOff(member, channel);
  } else if (cameraIsOn && warnedUsers.has(member.id)) {
    // They turned their camera on after being warned
    await clearWarning(member.id);
  }
});

// Prevent one bad interaction, network hiccup, or unexpected error from
// crashing the whole bot process. It gets logged instead, and the bot stays online.
client.on('error', (err) => {
  console.error('Discord client error:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (bot stays online):', err);
});

client.login(TOKEN);
