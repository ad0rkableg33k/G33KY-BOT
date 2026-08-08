// xXOnlineStatusXx Channel Indexer Bot
// - Exports every channel in the server to channels.json
// - Registers a /channel-index slash command that posts a formatted
//   list of channels (name + link) into whatever channel it's run in
// - Enforces an optional, per-server "cameras-on" voice channel policy
//
// This script does NOT rename, delete, or modify any channels.
// It only reads channel info, moves people out of voice when the camera
// policy says to, and posts messages.

require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Where persistent data files live. Locally this defaults to the current
// folder, so nothing changes for local testing. On Railway, set DATA_DIR
// to match your attached Volume's mount path (e.g. /data) so these files
// survive redeploys instead of getting wiped every time.
const DATA_DIR = process.env.DATA_DIR || '.';
function dataPath(filename) {
  return path.join(DATA_DIR, filename);
}

// Make sure the data directory actually exists before anything tries to
// write to it — also doubles as a diagnostic: if this logs an error, the
// path Railway gave us isn't actually a mounted, writable directory.
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log(`Data directory ready: ${path.resolve(DATA_DIR)}`);
} catch (err) {
  console.error(`Could not create/access DATA_DIR (${DATA_DIR}):`, err.message);
}

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  RoleSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID; // your primary server ID (used for startup convenience exports + seeding)

if (!TOKEN || !GUILD_ID) {
  console.error('Missing DISCORD_TOKEN or GUILD_ID in your .env file.');
  process.exit(1);
}

// GuildMembers is a PRIVILEGED intent — you must turn it on for this bot
// in the Discord Developer Portal (Bot page -> Privileged Gateway Intents
// -> Server Members Intent) or the bot will fail to log in with this intent
// enabled here.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages, // needed so the activity tracker can see messageCreate events
  ],
});

// ============================================================
// Cameras-On voice channel policy — PER-SERVER self-service config
// ============================================================
// Everything about the policy (on/off, which channels, which roles are
// exempt, timing, and an optional announcement link) lives in one JSON
// file, keyed by server ID, so every server the bot is in manages its own
// setup independently via slash commands — no code edits needed.

const CAMERA_CONFIG_FILE = dataPath('camera-config.json');
const DEFAULT_GRACE_MINUTES = 2; // silent period before the first reminder
const DEFAULT_WARNING_MINUTES = 3; // time after the reminder before removal

function loadCameraConfig() {
  try {
    return JSON.parse(fs.readFileSync(CAMERA_CONFIG_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveCameraConfig(config) {
  try {
    fs.writeFileSync(CAMERA_CONFIG_FILE, JSON.stringify(config, null, 2));
    return true;
  } catch (err) {
    console.error(`Failed to save camera-config.json to ${CAMERA_CONFIG_FILE}:`, err.message);
    return false;
  }
}

let cameraConfig = loadCameraConfig();
for (const [guildId, cfg] of Object.entries(cameraConfig)) {
  console.log(`[startup] Loaded camera-config.json for guild ${guildId}: enabled=${cfg.enabled}`);
}

function ensureGuildConfig(guildId) {
  if (!cameraConfig[guildId]) {
    cameraConfig[guildId] = {
      enabled: true,
      monitoredChannels: [],
      exemptRoles: [],
      graceMinutes: DEFAULT_GRACE_MINUTES,
      warningMinutes: DEFAULT_WARNING_MINUTES,
      announcementUrl: null,
      announcementChannelId: null,
    };
  }
  // Normalize configs saved before announcementChannelId existed
  if (cameraConfig[guildId].announcementChannelId === undefined) {
    cameraConfig[guildId].announcementChannelId = null;
  }
  return cameraConfig[guildId];
}

function isCameraPolicyEnabled(guildId) {
  return ensureGuildConfig(guildId).enabled !== false;
}

function setCameraPolicyEnabled(guildId, enabled) {
  ensureGuildConfig(guildId).enabled = enabled;
  return saveCameraConfig(cameraConfig);
}

function getMonitoredChannels(guildId) {
  return ensureGuildConfig(guildId).monitoredChannels;
}

function getExemptRoles(guildId) {
  return ensureGuildConfig(guildId).exemptRoles;
}

function getTiming(guildId) {
  const c = ensureGuildConfig(guildId);
  return {
    graceMinutes: c.graceMinutes ?? DEFAULT_GRACE_MINUTES,
    warningMinutes: c.warningMinutes ?? DEFAULT_WARNING_MINUTES,
  };
}

function getAnnouncementUrl(guildId) {
  return ensureGuildConfig(guildId).announcementUrl || null;
}

// ---- One-time migration/seed for xXOnlineStatusXx ----
// These were the previously hardcoded values. Kept only as a seed so
// nothing breaks/resets the first time this update runs. After that,
// camera-config.json is the live source of truth and these are unused.
const SEED_GUILD_ID = GUILD_ID;
const SEED_MONITORED_CHANNELS = [
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
const SEED_EXEMPT_ROLES = ['1522494914255126559', '1491315204162850858', '1491333963023650826'];
const SEED_ANNOUNCEMENT_URL = 'https://discord.com/channels/1491220089398235218/1530781873415127060/1534000463022784552';

function seedCameraConfigIfNeeded() {
  const isFirstRun = Object.keys(cameraConfig).length === 0;
  if (!isFirstRun || !SEED_GUILD_ID) return;

  // Best-effort: respect the old separate on/off file if it happens to exist
  let enabled = true;
  try {
    const old = JSON.parse(fs.readFileSync(dataPath('camera-policy-state.json'), 'utf-8'));
    if (typeof old[SEED_GUILD_ID] === 'boolean') enabled = old[SEED_GUILD_ID];
  } catch {
    // no old file, or unreadable — default to enabled
  }

  cameraConfig[SEED_GUILD_ID] = {
    enabled,
    monitoredChannels: [...SEED_MONITORED_CHANNELS],
    exemptRoles: [...SEED_EXEMPT_ROLES],
    graceMinutes: DEFAULT_GRACE_MINUTES,
    warningMinutes: DEFAULT_WARNING_MINUTES,
    announcementUrl: SEED_ANNOUNCEMENT_URL,
  };
  saveCameraConfig(cameraConfig);
  console.log('Seeded camera-config.json with the original xXOnlineStatusXx settings.');
}

// ============================================================
// Activity tracker — PER-SERVER self-service config
// ============================================================
// Tracks whether a member has sent a message and/or spent >=1 minute in a
// voice channel within a rolling window (default 30 days). Assigns an
// "Active" role or "Inactive" role. Inactive members get a self-service
// reactivation button (posted via /activity-tracker post-button) — clicking
// it counts as new activity and swaps their role instantly. The actual
// "quarantine" restriction (limiting inactive members to one channel) is
// done with normal Discord permission overwrites on the Inactive role, set
// up once by the server — this bot never touches channel permissions.

const ACTIVITY_CONFIG_FILE = dataPath('activity-config.json');
const ACTIVITY_DATA_FILE = dataPath('activity-data.json');
const DEFAULT_THRESHOLD_DAYS = 30;
const ACTIVITY_VOICE_MINUTES_REQUIRED = 1;

function loadActivityConfig() {
  try {
    return JSON.parse(fs.readFileSync(ACTIVITY_CONFIG_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveActivityConfig(config) {
  try {
    fs.writeFileSync(ACTIVITY_CONFIG_FILE, JSON.stringify(config, null, 2));
    return true;
  } catch (err) {
    console.error(`Failed to save activity-config.json to ${ACTIVITY_CONFIG_FILE}:`, err.message);
    return false;
  }
}

let activityConfig = loadActivityConfig();

function ensureActivityGuildConfig(guildId) {
  if (!activityConfig[guildId]) {
    activityConfig[guildId] = {
      enabled: false,
      activeRoleId: null,
      inactiveRoleId: null,
      thresholdDays: DEFAULT_THRESHOLD_DAYS,
      quarantineChannelId: null,
      exemptRoleIds: [],
      monitoredChannels: [],
    };
  }
  // Normalize configs saved before monitoredChannels existed
  if (activityConfig[guildId].monitoredChannels === undefined) {
    activityConfig[guildId].monitoredChannels = [];
  }
  return activityConfig[guildId];
}

function loadActivityData() {
  try {
    return JSON.parse(fs.readFileSync(ACTIVITY_DATA_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveActivityData(data) {
  fs.writeFileSync(ACTIVITY_DATA_FILE, JSON.stringify(data, null, 2));
}

let activityData = loadActivityData();

function getMemberActivity(guildId, userId) {
  if (!activityData[guildId]) activityData[guildId] = {};
  if (!activityData[guildId][userId]) {
    activityData[guildId][userId] = { lastMessageAt: 0, lastVoiceActiveAt: 0 };
  }
  return activityData[guildId][userId];
}

// ---- Voice tracking ----
// A member counts as "voice active" once they've spent >=1 continuous
// minute in ANY voice channel in the server (not just monitored camera
// channels — this is a separate, independent feature). Tracked via an
// in-memory join-time map, finalized on leave/switch, and swept
// periodically so long-running sessions count without requiring the
// member to ever leave.
const activityVoiceSessions = new Map(); // "guildId:userId" -> { joinedAt, channelId }
const ACTIVITY_VOICE_MS_REQUIRED = ACTIVITY_VOICE_MINUTES_REQUIRED * 60 * 1000;

function markVoiceActive(guildId, userId) {
  const activity = getMemberActivity(guildId, userId);
  activity.lastVoiceActiveAt = Date.now();
  saveActivityData(activityData);
}

function finalizeActivityVoiceSession(guildId, userId, key) {
  const session = activityVoiceSessions.get(key);
  activityVoiceSessions.delete(key);
  if (!session) return;
  const cfg = ensureActivityGuildConfig(guildId);
  // Empty monitoredChannels = track everywhere (default). Non-empty = only
  // count voice time spent in one of the picked channels.
  if (cfg.monitoredChannels.length && !cfg.monitoredChannels.includes(session.channelId)) return;
  if (Date.now() - session.joinedAt >= ACTIVITY_VOICE_MS_REQUIRED) {
    markVoiceActive(guildId, userId);
  }
}

client.on('voiceStateUpdate', (oldState, newState) => {
  const guildId = newState.guild.id;
  const userId = newState.id;
  const key = `${guildId}:${userId}`;
  const wasInChannel = !!oldState.channelId;
  const nowInChannel = !!newState.channelId;

  if (!wasInChannel && nowInChannel) {
    activityVoiceSessions.set(key, { joinedAt: Date.now(), channelId: newState.channelId });
  } else if (wasInChannel && !nowInChannel) {
    finalizeActivityVoiceSession(guildId, userId, key);
  } else if (wasInChannel && nowInChannel && oldState.channelId !== newState.channelId) {
    finalizeActivityVoiceSession(guildId, userId, key);
    activityVoiceSessions.set(key, { joinedAt: Date.now(), channelId: newState.channelId });
  }
});

// Sweep every 5 min so members who stay connected a long time still get
// credited without needing to leave the channel.
setInterval(() => {
  const now = Date.now();
  for (const [key, session] of activityVoiceSessions.entries()) {
    if (now - session.joinedAt >= ACTIVITY_VOICE_MS_REQUIRED) {
      const [guildId, userId] = key.split(':');
      const cfg = ensureActivityGuildConfig(guildId);
      if (cfg.monitoredChannels.length && !cfg.monitoredChannels.includes(session.channelId)) continue;
      markVoiceActive(guildId, userId);
    }
  }
}, 5 * 60 * 1000);

// ---- Message tracking ----
client.on('messageCreate', (message) => {
  if (!message.guild || message.author.bot) return;
  const cfg = ensureActivityGuildConfig(message.guild.id);
  // Empty monitoredChannels = track everywhere (default). Non-empty = only
  // count messages sent in one of the picked channels.
  if (cfg.monitoredChannels.length && !cfg.monitoredChannels.includes(message.channel.id)) return;
  const activity = getMemberActivity(message.guild.id, message.author.id);
  activity.lastMessageAt = Date.now();
  saveActivityData(activityData);
});

// ---- Role sync (scheduled) ----
// Runs once ~30s after startup, then every 6 hours. Also callable on-demand
// via /activity-tracker check (for one member) — full-server sync only runs
// on the schedule so we're not hammering the API on every command.
async function syncActivityRoles(guild) {
  const config = ensureActivityGuildConfig(guild.id);
  if (!config.enabled || !config.activeRoleId || !config.inactiveRoleId) return;

  const thresholdMs = config.thresholdDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const members = await guild.members.fetch();
  for (const member of members.values()) {
    if (member.user.bot) continue;
    if (config.exemptRoleIds.some((r) => member.roles.cache.has(r))) continue;

    const activity = activityData[guild.id]?.[member.id];
    const lastMessageAt = activity?.lastMessageAt || 0;
    const lastVoiceActiveAt = activity?.lastVoiceActiveAt || 0;
    // Brand-new members get a grace period — join date counts as their
    // baseline "last active" so nobody gets quarantined the day they join.
    const joinedAt = member.joinedTimestamp || 0;
    const lastActive = Math.max(lastMessageAt, lastVoiceActiveAt, joinedAt);

    const isActive = now - lastActive <= thresholdMs;

    try {
      if (isActive) {
        if (!member.roles.cache.has(config.activeRoleId)) await member.roles.add(config.activeRoleId);
        if (member.roles.cache.has(config.inactiveRoleId)) await member.roles.remove(config.inactiveRoleId);
      } else {
        if (!member.roles.cache.has(config.inactiveRoleId)) await member.roles.add(config.inactiveRoleId);
        if (member.roles.cache.has(config.activeRoleId)) await member.roles.remove(config.activeRoleId);
      }
    } catch (err) {
      console.error(`Activity role sync failed for ${member.id} in ${guild.id}:`, err.message);
    }
  }
}

async function syncAllActivityGuilds() {
  for (const guild of client.guilds.cache.values()) {
    await syncActivityRoles(guild);
  }
}

// ---- Reactivation button ----
function buildReactivationEmbedAndRow() {
  const embed = new EmbedBuilder()
    .setColor(0xffaa00)
    .setTitle("You've been marked inactive")
    .setDescription(
      "You haven't sent a message or spent time in voice recently, so you're currently limited to this channel.\n\n" +
        "Click the button below to let us know you're still around — this instantly restores your full access."
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('activity_reactivate').setLabel("I'm here — Reactivate me").setStyle(ButtonStyle.Success)
  );

  return { embed, row };
}

async function handleReactivateButton(interaction) {
  const config = ensureActivityGuildConfig(interaction.guild.id);
  const activity = getMemberActivity(interaction.guild.id, interaction.user.id);
  activity.lastMessageAt = Date.now();
  saveActivityData(activityData);

  const member = interaction.member;
  try {
    if (config.inactiveRoleId && member.roles.cache.has(config.inactiveRoleId)) {
      await member.roles.remove(config.inactiveRoleId);
    }
    if (config.activeRoleId && !member.roles.cache.has(config.activeRoleId)) {
      await member.roles.add(config.activeRoleId);
    }
    await interaction.reply({ content: "Welcome back! You've been reactivated — full access restored.", ephemeral: true });
  } catch (err) {
    console.error('Reactivation failed:', err);
    await interaction.reply({ content: 'Something went wrong reactivating you — ping a mod for help.', ephemeral: true });
  }
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  if (interaction.customId === 'activity_reactivate') {
    await handleReactivateButton(interaction);
  }
});

// ============================================================
// Unified /setup menu — interactive wizard for camera policy +
// activity tracker, so admins never have to type role/channel IDs or
// remember subcommand names. Everything reuses the exact same config
// objects/functions as the slash commands above — the menu is just
// another way to edit the same camera-config.json / activity-config.json.
// ============================================================

function clearAllCameraWarningsForGuild(guildId) {
  for (const [key, info] of warnedUsers.entries()) {
    if (key.startsWith(`${guildId}:`)) {
      if (info.graceTimeoutId) clearTimeout(info.graceTimeoutId);
      if (info.warnTimeoutId) clearTimeout(info.warnTimeoutId);
      warnedUsers.delete(key);
    }
  }
}

function buildMainMenuMessage() {
  const embed = new EmbedBuilder()
    .setColor(0x8a2be2)
    .setTitle('⚙️ G33KY Bot Setup')
    .setDescription('Pick what you want to configure. Everything here saves instantly — no need to type commands.');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:camera:menu').setLabel('📷 Camera Policy').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('setup:activity:menu').setLabel('📊 Activity Tracker').setStyle(ButtonStyle.Primary)
  );

  return { embeds: [embed], components: [row] };
}

function buildCameraMenuMessage(guildId) {
  const cfg = ensureGuildConfig(guildId);

  const embed = new EmbedBuilder()
    .setColor(cfg.enabled ? 0x00cc66 : 0x999999)
    .setTitle('📷 Camera Policy Setup')
    .addFields(
      { name: 'Status', value: cfg.enabled ? '🟢 ON' : '⚪ OFF', inline: true },
      { name: 'Timing', value: `${cfg.graceMinutes ?? DEFAULT_GRACE_MINUTES}m grace + ${cfg.warningMinutes ?? DEFAULT_WARNING_MINUTES}m warning`, inline: true },
      { name: 'Announcement', value: cfg.announcementUrl ? `[view post](${cfg.announcementUrl})` : 'Not posted yet', inline: true },
      { name: 'Monitored channels', value: cfg.monitoredChannels.length ? cfg.monitoredChannels.map((id) => `<#${id}>`).join(', ') : 'None — pick some below' },
      { name: 'Exempt roles', value: cfg.exemptRoles.length ? cfg.exemptRoles.map((id) => `<@&${id}>`).join(', ') : 'None' }
    );

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('setup:camera:channels:select')
    .setPlaceholder('Monitored voice channels')
    .setChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
    .setMinValues(0)
    .setMaxValues(25);
  if (cfg.monitoredChannels.length) channelSelect.setDefaultChannels(...cfg.monitoredChannels.slice(0, 25));

  const roleSelect = new RoleSelectMenuBuilder()
    .setCustomId('setup:camera:exempt:select')
    .setPlaceholder('Exempt roles')
    .setMinValues(0)
    .setMaxValues(25);
  if (cfg.exemptRoles.length) roleSelect.setDefaultRoles(...cfg.exemptRoles.slice(0, 25));

  const announceChannelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('setup:camera:announce-channel:select')
    .setPlaceholder('Announcement channel')
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    .setMinValues(0)
    .setMaxValues(1);
  if (cfg.announcementChannelId) announceChannelSelect.setDefaultChannels(cfg.announcementChannelId);

  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('setup:camera:toggle')
      .setLabel(cfg.enabled ? 'Turn OFF' : 'Turn ON')
      .setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('setup:camera:timing').setLabel('Timing').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:camera:create-exempt-role').setLabel('✨ Create Exempt Role').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:camera:announce-post').setLabel('📢 Post Announcement').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('setup:main').setLabel('⬅ Back').setStyle(ButtonStyle.Secondary)
  );

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(channelSelect),
      new ActionRowBuilder().addComponents(roleSelect),
      new ActionRowBuilder().addComponents(announceChannelSelect),
      buttonRow,
    ],
  };
}

// ---- Activity tracker menu: split across 3 pages (main / roles / channels)
// because Discord caps messages at 5 component rows and this feature has
// more pickers than camera policy does.
function buildActivityMenuMessage(guildId) {
  const cfg = ensureActivityGuildConfig(guildId);

  const embed = new EmbedBuilder()
    .setColor(cfg.enabled ? 0x00cc66 : 0x999999)
    .setTitle('📊 Activity Tracker Setup')
    .setDescription('Use the buttons below to set up roles, channels, and timing.')
    .addFields(
      { name: 'Status', value: cfg.enabled ? '🟢 ON' : '⚪ OFF', inline: true },
      { name: 'Threshold', value: `${cfg.thresholdDays} days`, inline: true },
      { name: 'Quarantine channel', value: cfg.quarantineChannelId ? `<#${cfg.quarantineChannelId}>` : 'Not set', inline: true },
      { name: 'Active role', value: cfg.activeRoleId ? `<@&${cfg.activeRoleId}>` : 'Not set', inline: true },
      { name: 'Inactive role', value: cfg.inactiveRoleId ? `<@&${cfg.inactiveRoleId}>` : 'Not set', inline: true },
      { name: 'Exempt roles', value: cfg.exemptRoleIds.length ? cfg.exemptRoleIds.map((id) => `<@&${id}>`).join(', ') : 'None', inline: true },
      {
        name: 'Monitored channels',
        value: cfg.monitoredChannels.length ? cfg.monitoredChannels.map((id) => `<#${id}>`).join(', ') : 'All channels (default)',
      }
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:activity:roles-menu').setLabel('🎭 Roles').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('setup:activity:channels-menu').setLabel('# Channels').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('setup:activity:threshold').setLabel('⏱ Threshold').setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('setup:activity:toggle')
      .setLabel(cfg.enabled ? 'Turn OFF' : 'Turn ON')
      .setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('setup:activity:postbutton').setLabel('📨 Post Reactivation Button').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:main').setLabel('⬅ Back').setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1, row2] };
}

function buildActivityRolesMenuMessage(guildId) {
  const cfg = ensureActivityGuildConfig(guildId);

  const embed = new EmbedBuilder()
    .setColor(0x8a2be2)
    .setTitle('📊 Activity Tracker — Roles')
    .addFields(
      { name: 'Active role', value: cfg.activeRoleId ? `<@&${cfg.activeRoleId}>` : 'Not set', inline: true },
      { name: 'Inactive role', value: cfg.inactiveRoleId ? `<@&${cfg.inactiveRoleId}>` : 'Not set', inline: true },
      { name: 'Exempt roles', value: cfg.exemptRoleIds.length ? cfg.exemptRoleIds.map((id) => `<@&${id}>`).join(', ') : 'None' }
    );

  const activeRoleSelect = new RoleSelectMenuBuilder().setCustomId('setup:activity:activerole:select').setPlaceholder('Active role').setMinValues(1).setMaxValues(1);
  if (cfg.activeRoleId) activeRoleSelect.setDefaultRoles(cfg.activeRoleId);

  const inactiveRoleSelect = new RoleSelectMenuBuilder().setCustomId('setup:activity:inactiverole:select').setPlaceholder('Inactive role').setMinValues(1).setMaxValues(1);
  if (cfg.inactiveRoleId) inactiveRoleSelect.setDefaultRoles(cfg.inactiveRoleId);

  const exemptSelect = new RoleSelectMenuBuilder().setCustomId('setup:activity:exempt:select').setPlaceholder('Exempt roles').setMinValues(0).setMaxValues(25);
  if (cfg.exemptRoleIds.length) exemptSelect.setDefaultRoles(...cfg.exemptRoleIds.slice(0, 25));

  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:activity:create-active-role').setLabel('✨ Create Active Role').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:activity:create-inactive-role').setLabel('✨ Create Inactive Role').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:activity:create-exempt-role').setLabel('✨ Create Exempt Role').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:activity:menu').setLabel('⬅ Back').setStyle(ButtonStyle.Secondary)
  );

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(activeRoleSelect),
      new ActionRowBuilder().addComponents(inactiveRoleSelect),
      new ActionRowBuilder().addComponents(exemptSelect),
      buttonRow,
    ],
  };
}

function buildActivityChannelsMenuMessage(guildId) {
  const cfg = ensureActivityGuildConfig(guildId);

  const embed = new EmbedBuilder()
    .setColor(0x8a2be2)
    .setTitle('📊 Activity Tracker — Channels')
    .addFields(
      { name: 'Quarantine / reactivation channel', value: cfg.quarantineChannelId ? `<#${cfg.quarantineChannelId}>` : 'Not set' },
      {
        name: 'Monitored channels',
        value: cfg.monitoredChannels.length
          ? cfg.monitoredChannels.map((id) => `<#${id}>`).join(', ')
          : 'All channels (default) — pick specific ones below to narrow what counts as activity',
      }
    );

  const quarantineSelect = new ChannelSelectMenuBuilder()
    .setCustomId('setup:activity:quarantine:select')
    .setPlaceholder('Quarantine / reactivation channel')
    .setChannelTypes(ChannelType.GuildText)
    .setMinValues(1)
    .setMaxValues(1);
  if (cfg.quarantineChannelId) quarantineSelect.setDefaultChannels(cfg.quarantineChannelId);

  const monitoredSelect = new ChannelSelectMenuBuilder()
    .setCustomId('setup:activity:channels:select')
    .setPlaceholder('Channels to track (leave empty = everywhere)')
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice)
    .setMinValues(0)
    .setMaxValues(25);
  if (cfg.monitoredChannels.length) monitoredSelect.setDefaultChannels(...cfg.monitoredChannels.slice(0, 25));

  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:activity:create-quarantine-channel').setLabel('✨ Create Reactivation Channel').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:activity:menu').setLabel('⬅ Back').setStyle(ButtonStyle.Secondary)
  );

  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(quarantineSelect), new ActionRowBuilder().addComponents(monitoredSelect), buttonRow],
  };
}

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'setup') {
      return interaction.reply({ ...buildMainMenuMessage(), ephemeral: true });
    }

    if (!interaction.customId || !interaction.customId.startsWith('setup:')) return;
    if (!interaction.isButton() && !interaction.isRoleSelectMenu() && !interaction.isChannelSelectMenu() && !interaction.isModalSubmit()) return;

    const guildId = interaction.guildId;
    const id = interaction.customId;

    // ---- Navigation ----
    if (id === 'setup:main') return interaction.update(buildMainMenuMessage());
    if (id === 'setup:camera:menu') return interaction.update(buildCameraMenuMessage(guildId));
    if (id === 'setup:activity:menu') return interaction.update(buildActivityMenuMessage(guildId));
    if (id === 'setup:activity:roles-menu') return interaction.update(buildActivityRolesMenuMessage(guildId));
    if (id === 'setup:activity:channels-menu') return interaction.update(buildActivityChannelsMenuMessage(guildId));

    // ---- Camera policy ----
    if (id === 'setup:camera:toggle') {
      const cfg = ensureGuildConfig(guildId);
      cfg.enabled = !cfg.enabled;
      const saved = saveCameraConfig(cameraConfig);
      if (!cfg.enabled) clearAllCameraWarningsForGuild(guildId);
      await interaction.update(buildCameraMenuMessage(guildId));
      if (!saved) {
        await interaction.followUp({
          content: "⚠️ This didn't save to disk — it'll revert if the bot restarts. Check Railway logs for a DATA_DIR write error.",
          ephemeral: true,
        });
      }
      return;
    }

    if (id === 'setup:camera:channels:select') {
      const cfg = ensureGuildConfig(guildId);
      cfg.monitoredChannels = interaction.values;
      saveCameraConfig(cameraConfig);
      return interaction.update(buildCameraMenuMessage(guildId));
    }

    if (id === 'setup:camera:exempt:select') {
      const cfg = ensureGuildConfig(guildId);
      cfg.exemptRoles = interaction.values;
      saveCameraConfig(cameraConfig);
      return interaction.update(buildCameraMenuMessage(guildId));
    }

    if (id === 'setup:camera:announce-channel:select') {
      const cfg = ensureGuildConfig(guildId);
      cfg.announcementChannelId = interaction.values[0] || null;
      saveCameraConfig(cameraConfig);
      return interaction.update(buildCameraMenuMessage(guildId));
    }

    if (id === 'setup:camera:timing') {
      const cfg = ensureGuildConfig(guildId);
      const modal = new ModalBuilder().setCustomId('setup:camera:timing:modal').setTitle('Camera Policy Timing');
      const graceInput = new TextInputBuilder()
        .setCustomId('grace')
        .setLabel('Grace period (minutes, silent)')
        .setStyle(TextInputStyle.Short)
        .setValue(String(cfg.graceMinutes ?? DEFAULT_GRACE_MINUTES))
        .setRequired(true);
      const warningInput = new TextInputBuilder()
        .setCustomId('warning')
        .setLabel('Warning period (minutes, after reminder)')
        .setStyle(TextInputStyle.Short)
        .setValue(String(cfg.warningMinutes ?? DEFAULT_WARNING_MINUTES))
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(graceInput), new ActionRowBuilder().addComponents(warningInput));
      return interaction.showModal(modal);
    }

    if (id === 'setup:camera:timing:modal') {
      const grace = parseInt(interaction.fields.getTextInputValue('grace'), 10);
      const warning = parseInt(interaction.fields.getTextInputValue('warning'), 10);
      if (!Number.isInteger(grace) || !Number.isInteger(warning) || grace < 0 || warning < 1) {
        return interaction.reply({ content: '❌ Grace must be 0+ and warning must be 1+ (whole numbers, in minutes).', ephemeral: true });
      }
      const cfg = ensureGuildConfig(guildId);
      cfg.graceMinutes = grace;
      cfg.warningMinutes = warning;
      saveCameraConfig(cameraConfig);
      return interaction.update(buildCameraMenuMessage(guildId));
    }

    if (id === 'setup:camera:create-exempt-role') {
      const cfg = ensureGuildConfig(guildId);
      try {
        const role = await interaction.guild.roles.create({
          name: 'Camera Policy Exempt',
          color: 0x3498db,
          reason: 'Created via /setup — camera policy',
        });
        cfg.exemptRoles.push(role.id);
        saveCameraConfig(cameraConfig);
        await interaction.update(buildCameraMenuMessage(guildId));
      } catch (err) {
        console.error('Failed to create camera exempt role:', err.message);
        await interaction.reply({
          content: `❌ Couldn't create that role — make sure I have the **Manage Roles** permission. (${err.message})`,
          ephemeral: true,
        });
      }
      return;
    }

    if (id === 'setup:camera:announce-post') {
      const cfg = ensureGuildConfig(guildId);
      if (!cfg.announcementChannelId) {
        return interaction.reply({ content: '❌ Pick an announcement channel below first.', ephemeral: true });
      }
      const defaultText =
        'Cameras must be ON while in monitored voice channels.\n\n' +
        `If your camera is off, you'll get a silent ${cfg.graceMinutes ?? DEFAULT_GRACE_MINUTES} minute grace period, then a reminder, ` +
        `then ${cfg.warningMinutes ?? DEFAULT_WARNING_MINUTES} more minute(s) before you're moved out of the channel. ` +
        'Turning your camera back on at any point cancels the timer.';
      const modal = new ModalBuilder().setCustomId('setup:camera:announce-post:modal').setTitle('Post Camera Policy Announcement');
      const textInput = new TextInputBuilder()
        .setCustomId('text')
        .setLabel('Policy text')
        .setStyle(TextInputStyle.Paragraph)
        .setValue(defaultText)
        .setRequired(true)
        .setMaxLength(3500);
      modal.addComponents(new ActionRowBuilder().addComponents(textInput));
      return interaction.showModal(modal);
    }

    if (id === 'setup:camera:announce-post:modal') {
      const cfg = ensureGuildConfig(guildId);
      const text = interaction.fields.getTextInputValue('text');
      try {
        const channel = await interaction.guild.channels.fetch(cfg.announcementChannelId);
        const embed = new EmbedBuilder().setColor(0x8a2be2).setTitle('📷 Camera Policy').setDescription(text).setTimestamp();
        const message = await channel.send({ embeds: [embed] });
        cfg.announcementUrl = `https://discord.com/channels/${guildId}/${channel.id}/${message.id}`;
        saveCameraConfig(cameraConfig);
        await interaction.update(buildCameraMenuMessage(guildId));
      } catch (err) {
        console.error('Failed to post camera policy announcement:', err.message);
        await interaction.reply({
          content: `❌ Couldn't post that — make sure I can send messages and embed links in that channel. (${err.message})`,
          ephemeral: true,
        });
      }
      return;
    }

    // ---- Activity tracker: main page ----
    if (id === 'setup:activity:toggle') {
      const cfg = ensureActivityGuildConfig(guildId);
      if (!cfg.enabled && (!cfg.activeRoleId || !cfg.inactiveRoleId)) {
        return interaction.reply({ content: '❌ Pick both an Active role and an Inactive role in the Roles page before turning this on.', ephemeral: true });
      }
      cfg.enabled = !cfg.enabled;
      const saved = saveActivityConfig(activityConfig);
      if (cfg.enabled) syncActivityRoles(interaction.guild);
      await interaction.update(buildActivityMenuMessage(guildId));
      if (!saved) {
        await interaction.followUp({
          content: "⚠️ This didn't save to disk — it'll revert if the bot restarts. Check Railway logs for a DATA_DIR write error.",
          ephemeral: true,
        });
      }
      return;
    }

    if (id === 'setup:activity:threshold') {
      const cfg = ensureActivityGuildConfig(guildId);
      const modal = new ModalBuilder().setCustomId('setup:activity:threshold:modal').setTitle('Inactivity Threshold');
      const daysInput = new TextInputBuilder()
        .setCustomId('days')
        .setLabel('Days of inactivity before "Inactive"')
        .setStyle(TextInputStyle.Short)
        .setValue(String(cfg.thresholdDays))
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(daysInput));
      return interaction.showModal(modal);
    }

    if (id === 'setup:activity:threshold:modal') {
      const days = parseInt(interaction.fields.getTextInputValue('days'), 10);
      if (!Number.isInteger(days) || days < 1) {
        return interaction.reply({ content: '❌ Threshold must be a whole number of days, 1 or more.', ephemeral: true });
      }
      const cfg = ensureActivityGuildConfig(guildId);
      cfg.thresholdDays = days;
      saveActivityConfig(activityConfig);
      return interaction.update(buildActivityMenuMessage(guildId));
    }

    if (id === 'setup:activity:postbutton') {
      const cfg = ensureActivityGuildConfig(guildId);
      if (!cfg.quarantineChannelId) {
        return interaction.reply({ content: '❌ Pick a quarantine channel in the Channels page first.', ephemeral: true });
      }
      const channel = await interaction.guild.channels.fetch(cfg.quarantineChannelId);
      const { embed: btnEmbed, row: btnRow } = buildReactivationEmbedAndRow();
      await channel.send({ embeds: [btnEmbed], components: [btnRow] });
      return interaction.reply({ content: `✅ Reactivation button posted in **#${channel.name}**.`, ephemeral: true });
    }

    // ---- Activity tracker: roles page ----
    if (id === 'setup:activity:activerole:select') {
      const cfg = ensureActivityGuildConfig(guildId);
      cfg.activeRoleId = interaction.values[0];
      saveActivityConfig(activityConfig);
      return interaction.update(buildActivityRolesMenuMessage(guildId));
    }

    if (id === 'setup:activity:inactiverole:select') {
      const cfg = ensureActivityGuildConfig(guildId);
      cfg.inactiveRoleId = interaction.values[0];
      saveActivityConfig(activityConfig);
      return interaction.update(buildActivityRolesMenuMessage(guildId));
    }

    if (id === 'setup:activity:exempt:select') {
      const cfg = ensureActivityGuildConfig(guildId);
      cfg.exemptRoleIds = interaction.values;
      saveActivityConfig(activityConfig);
      return interaction.update(buildActivityRolesMenuMessage(guildId));
    }

    if (id === 'setup:activity:create-active-role') {
      const cfg = ensureActivityGuildConfig(guildId);
      try {
        const role = await interaction.guild.roles.create({ name: 'Active Member', color: 0x00cc66, reason: 'Created via /setup — activity tracker' });
        cfg.activeRoleId = role.id;
        saveActivityConfig(activityConfig);
        await interaction.update(buildActivityRolesMenuMessage(guildId));
      } catch (err) {
        console.error('Failed to create Active Member role:', err.message);
        await interaction.reply({ content: `❌ Couldn't create that role — make sure I have the **Manage Roles** permission. (${err.message})`, ephemeral: true });
      }
      return;
    }

    if (id === 'setup:activity:create-inactive-role') {
      const cfg = ensureActivityGuildConfig(guildId);
      try {
        const role = await interaction.guild.roles.create({ name: 'Inactive Member', color: 0x999999, reason: 'Created via /setup — activity tracker' });
        cfg.inactiveRoleId = role.id;
        saveActivityConfig(activityConfig);
        await interaction.update(buildActivityRolesMenuMessage(guildId));
      } catch (err) {
        console.error('Failed to create Inactive Member role:', err.message);
        await interaction.reply({ content: `❌ Couldn't create that role — make sure I have the **Manage Roles** permission. (${err.message})`, ephemeral: true });
      }
      return;
    }

    if (id === 'setup:activity:create-exempt-role') {
      const cfg = ensureActivityGuildConfig(guildId);
      try {
        const role = await interaction.guild.roles.create({ name: 'Activity Tracker Exempt', color: 0x3498db, reason: 'Created via /setup — activity tracker' });
        cfg.exemptRoleIds.push(role.id);
        saveActivityConfig(activityConfig);
        await interaction.update(buildActivityRolesMenuMessage(guildId));
      } catch (err) {
        console.error('Failed to create activity exempt role:', err.message);
        await interaction.reply({ content: `❌ Couldn't create that role — make sure I have the **Manage Roles** permission. (${err.message})`, ephemeral: true });
      }
      return;
    }

    // ---- Activity tracker: channels page ----
    if (id === 'setup:activity:quarantine:select') {
      const cfg = ensureActivityGuildConfig(guildId);
      cfg.quarantineChannelId = interaction.values[0];
      saveActivityConfig(activityConfig);
      return interaction.update(buildActivityChannelsMenuMessage(guildId));
    }

    if (id === 'setup:activity:channels:select') {
      const cfg = ensureActivityGuildConfig(guildId);
      cfg.monitoredChannels = interaction.values;
      saveActivityConfig(activityConfig);
      return interaction.update(buildActivityChannelsMenuMessage(guildId));
    }

    if (id === 'setup:activity:create-quarantine-channel') {
      const cfg = ensureActivityGuildConfig(guildId);
      try {
        const permissionOverwrites = [];
        if (cfg.inactiveRoleId) {
          permissionOverwrites.push({
            id: cfg.inactiveRoleId,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
          });
        }
        const channel = await interaction.guild.channels.create({
          name: 're-activate',
          type: ChannelType.GuildText,
          reason: 'Created via /setup — activity tracker',
          permissionOverwrites,
        });
        cfg.quarantineChannelId = channel.id;
        saveActivityConfig(activityConfig);
        await interaction.update(buildActivityChannelsMenuMessage(guildId));
        if (!cfg.inactiveRoleId) {
          await interaction.followUp({
            content:
              "⚠️ Created #re-activate, but you haven't set your Inactive role yet — set it in the Roles page, then re-run this so I can grant it access to this channel.",
            ephemeral: true,
          });
        }
      } catch (err) {
        console.error('Failed to create reactivation channel:', err.message);
        await interaction.reply({ content: `❌ Couldn't create that channel — make sure I have the **Manage Channels** permission. (${err.message})`, ephemeral: true });
      }
      return;
    }
  } catch (err) {
    console.error('Error handling /setup interaction:', err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: 'Something went wrong — check the terminal for details.', ephemeral: true });
      } else {
        await interaction.reply({ content: 'Something went wrong — check the terminal for details.', ephemeral: true });
      }
    } catch (followUpErr) {
      console.error('Could not send setup error response:', followUpErr.message);
    }
  }
});

// ============================================================
// /channel-index config (unrelated to the camera policy above)
// ============================================================

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
  new SlashCommandBuilder()
    .setName('camera-status')
    .setDescription('View the full current camera policy configuration for this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('camera-monitor')
    .setDescription('Manage which voice channels enforce the cameras-on policy in this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Start monitoring a voice channel')
        .addChannelOption((opt) => opt.setName('channel').setDescription('The voice channel to monitor').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Stop monitoring a voice channel')
        .addChannelOption((opt) => opt.setName('channel').setDescription('The voice channel to stop monitoring').setRequired(true))
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('List all monitored voice channels in this server')),
  new SlashCommandBuilder()
    .setName('camera-exempt-role')
    .setDescription('Manage which roles are exempt from the cameras-on policy in this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Exempt a role from the camera policy')
        .addRoleOption((opt) => opt.setName('role').setDescription('The role to exempt').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription("Remove a role's exemption")
        .addRoleOption((opt) => opt.setName('role').setDescription('The role to un-exempt').setRequired(true))
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('List all exempt roles in this server')),
  new SlashCommandBuilder()
    .setName('camera-timing')
    .setDescription('Configure camera policy timing for this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Set the grace period and warning period')
        .addIntegerOption((opt) =>
          opt
            .setName('grace_minutes')
            .setDescription('Silent period before the first reminder (minutes)')
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(60)
        )
        .addIntegerOption((opt) =>
          opt
            .setName('warning_minutes')
            .setDescription('Time after the reminder before removal (minutes)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(60)
        )
    )
    .addSubcommand((sub) => sub.setName('view').setDescription('View current timing settings')),
  new SlashCommandBuilder()
    .setName('camera-announcement')
    .setDescription('Set a link to your camera policy announcement, included in reminders')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Set the announcement link')
        .addStringOption((opt) => opt.setName('url').setDescription('Link to your policy announcement post').setRequired(true))
    )
    .addSubcommand((sub) => sub.setName('clear').setDescription('Remove the announcement link'))
    .addSubcommand((sub) => sub.setName('view').setDescription('View the current announcement link')),
  new SlashCommandBuilder()
    .setName('activity-tracker')
    .setDescription('Configure automatic active/inactive member tracking')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) => sub.setName('enable').setDescription('Turn on activity tracking for this server'))
    .addSubcommand((sub) => sub.setName('disable').setDescription('Turn off activity tracking for this server'))
    .addSubcommand((sub) =>
      sub
        .setName('set-roles')
        .setDescription('Set the Active and Inactive roles')
        .addRoleOption((opt) => opt.setName('active').setDescription('Role for active members').setRequired(true))
        .addRoleOption((opt) => opt.setName('inactive').setDescription('Role for inactive members').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-threshold')
        .setDescription('Days of inactivity before someone is marked inactive (default 30)')
        .addIntegerOption((opt) => opt.setName('days').setDescription('Number of days').setRequired(true).setMinValue(1))
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-quarantine-channel')
        .setDescription('The channel inactive members can still see, to reactivate themselves')
        .addChannelOption((opt) => opt.setName('channel').setDescription('Channel').setRequired(true))
    )
    .addSubcommandGroup((group) =>
      group
        .setName('exempt-role')
        .setDescription('Roles skipped by activity tracking entirely (e.g. staff/bots)')
        .addSubcommand((sub) =>
          sub.setName('add').setDescription('Exempt a role').addRoleOption((opt) => opt.setName('role').setDescription('Role').setRequired(true))
        )
        .addSubcommand((sub) =>
          sub
            .setName('remove')
            .setDescription('Remove an exemption')
            .addRoleOption((opt) => opt.setName('role').setDescription('Role').setRequired(true))
        )
        .addSubcommand((sub) => sub.setName('list').setDescription('List exempt roles'))
    )
    .addSubcommand((sub) => sub.setName('post-button').setDescription('Post the reactivation button in the quarantine channel'))
    .addSubcommand((sub) => sub.setName('status').setDescription('View current activity tracker configuration'))
    .addSubcommand((sub) =>
      sub
        .setName('check')
        .setDescription("Manually check one member's activity status")
        .addUserOption((opt) => opt.setName('user').setDescription('Member to check').setRequired(true))
    ),
].map((cmd) => cmd.toJSON());

// ---- Register slash commands with Discord (GLOBAL = works in every server
// the bot is in, not just this one — takes up to ~1 hour to first propagate
// after a change, unlike guild-scoped registration which was instant) ----
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), {
    body: commands,
  });
  console.log('Slash commands registered globally (may take up to ~1hr to appear on a first-time change).');
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

const CHANNELS_FILE = dataPath('channels.json');

// ---- Export to local channels.json ----
function exportToFile(guild) {
  const data = getChannelData(guild);
  fs.writeFileSync(CHANNELS_FILE, JSON.stringify(data, null, 2));
  console.log(`Wrote ${data.length} channels to ${CHANNELS_FILE}`);
  return data;
}

// ---- descriptions.json: hand-maintained channel descriptions ----
// Keyed by channel ID (not name) so two channels that happen to share a
// name in different categories never collide. Each entry also stores the
// channel's current name so the file stays readable when you're editing it
// by hand — you can see at a glance which ID belongs to which channel.
const DESCRIPTIONS_FILE = dataPath('descriptions.json');

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
  seedCameraConfigIfNeeded();

  // Also do a one-time export to file on startup, so you get channels.json
  // immediately without needing to run a slash command first.
  const guild = await client.guilds.fetch(GUILD_ID);
  exportToFile(guild);
  ensureDescriptionsFile(guild);

  // Activity tracker: first sync shortly after startup (let the member
  // cache warm up), then every 6 hours after that.
  setTimeout(syncAllActivityGuilds, 30 * 1000);
  setInterval(syncAllActivityGuilds, 6 * 60 * 60 * 1000);
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
        files: [CHANNELS_FILE],
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
      const enabled = desiredState === 'on';
      const saved = setCameraPolicyEnabled(interaction.guildId, enabled);

      if (!enabled) {
        // Clear any warnings currently in flight FOR THIS SERVER ONLY, so
        // nobody gets moved out after the policy's been switched off here —
        // doesn't touch other servers' active warnings
        for (const [key, info] of warnedUsers.entries()) {
          if (key.startsWith(`${interaction.guildId}:`)) {
            if (info.graceTimeoutId) clearTimeout(info.graceTimeoutId);
            if (info.warnTimeoutId) clearTimeout(info.warnTimeoutId);
            warnedUsers.delete(key);
          }
        }
      }

      const saveWarning = saved
        ? ''
        : "\n⚠️ **This didn't save to disk** — it'll work for now, but will revert if the bot restarts. Check Railway logs for a DATA_DIR write error.";

      await interaction.reply({
        content:
          (enabled
            ? '📷 Cameras-on policy is now **ON** — camera required in monitored voice channels.'
            : '📴 Cameras-on policy is now **OFF** — no camera enforcement until turned back on.') + saveWarning,
        ephemeral: false,
      });
    }

    if (interaction.commandName === 'camera-status') {
      const cfg = ensureGuildConfig(interaction.guildId);
      const embed = new EmbedBuilder()
        .setColor(cfg.enabled ? 0x00cc66 : 0x999999)
        .setTitle('📷 Camera Policy Status')
        .addFields(
          { name: 'Enabled', value: cfg.enabled ? 'Yes' : 'No', inline: true },
          { name: 'Grace period', value: `${cfg.graceMinutes ?? DEFAULT_GRACE_MINUTES} minute(s)`, inline: true },
          { name: 'Warning period', value: `${cfg.warningMinutes ?? DEFAULT_WARNING_MINUTES} minute(s)`, inline: true },
          {
            name: `Monitored channels (${cfg.monitoredChannels.length})`,
            value: cfg.monitoredChannels.length ? cfg.monitoredChannels.map((id) => `<#${id}>`).join(', ') : 'None',
          },
          {
            name: `Exempt roles (${cfg.exemptRoles.length})`,
            value: cfg.exemptRoles.length ? cfg.exemptRoles.map((id) => `<@&${id}>`).join(', ') : 'None',
          },
          { name: 'Announcement link', value: cfg.announcementUrl ? cfg.announcementUrl : 'Not set' }
        );
      await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.commandName === 'camera-monitor') {
      const sub = interaction.options.getSubcommand();
      const guildConfig = ensureGuildConfig(interaction.guildId);

      if (sub === 'add') {
        const channel = interaction.options.getChannel('channel');
        if (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice) {
          await interaction.reply({ content: '❌ That needs to be a voice channel.', ephemeral: true });
        } else if (guildConfig.monitoredChannels.includes(channel.id)) {
          await interaction.reply({ content: `**#${channel.name}** is already being monitored.`, ephemeral: true });
        } else {
          guildConfig.monitoredChannels.push(channel.id);
          saveCameraConfig(cameraConfig);
          await interaction.reply(`✅ Now monitoring **#${channel.name}** for the cameras-on policy.`);
        }
      } else if (sub === 'remove') {
        const channel = interaction.options.getChannel('channel');
        if (!guildConfig.monitoredChannels.includes(channel.id)) {
          await interaction.reply({ content: `**#${channel.name}** wasn't being monitored.`, ephemeral: true });
        } else {
          guildConfig.monitoredChannels = guildConfig.monitoredChannels.filter((id) => id !== channel.id);
          saveCameraConfig(cameraConfig);
          await interaction.reply(`✅ Stopped monitoring **#${channel.name}**.`);
        }
      } else if (sub === 'list') {
        if (guildConfig.monitoredChannels.length === 0) {
          await interaction.reply({ content: 'No voice channels are currently being monitored in this server.', ephemeral: true });
        } else {
          const list = guildConfig.monitoredChannels.map((id) => `<#${id}>`).join('\n');
          await interaction.reply({ content: `**Monitored voice channels:**\n${list}`, ephemeral: true });
        }
      }
    }

    if (interaction.commandName === 'camera-exempt-role') {
      const sub = interaction.options.getSubcommand();
      const guildConfig = ensureGuildConfig(interaction.guildId);

      if (sub === 'add') {
        const role = interaction.options.getRole('role');
        if (guildConfig.exemptRoles.includes(role.id)) {
          await interaction.reply({ content: `**${role.name}** is already exempt.`, ephemeral: true });
        } else {
          guildConfig.exemptRoles.push(role.id);
          saveCameraConfig(cameraConfig);
          await interaction.reply(`✅ **${role.name}** is now exempt from the cameras-on policy.`);
        }
      } else if (sub === 'remove') {
        const role = interaction.options.getRole('role');
        if (!guildConfig.exemptRoles.includes(role.id)) {
          await interaction.reply({ content: `**${role.name}** wasn't exempt.`, ephemeral: true });
        } else {
          guildConfig.exemptRoles = guildConfig.exemptRoles.filter((id) => id !== role.id);
          saveCameraConfig(cameraConfig);
          await interaction.reply(`✅ **${role.name}** is no longer exempt.`);
        }
      } else if (sub === 'list') {
        if (guildConfig.exemptRoles.length === 0) {
          await interaction.reply({ content: 'No roles are currently exempt in this server.', ephemeral: true });
        } else {
          const list = guildConfig.exemptRoles.map((id) => `<@&${id}>`).join('\n');
          await interaction.reply({ content: `**Exempt roles:**\n${list}`, ephemeral: true });
        }
      }
    }

    if (interaction.commandName === 'camera-timing') {
      const sub = interaction.options.getSubcommand();
      const guildConfig = ensureGuildConfig(interaction.guildId);

      if (sub === 'set') {
        const grace = interaction.options.getInteger('grace_minutes');
        const warning = interaction.options.getInteger('warning_minutes');
        guildConfig.graceMinutes = grace;
        guildConfig.warningMinutes = warning;
        saveCameraConfig(cameraConfig);
        await interaction.reply(
          `✅ Updated timing: **${grace} minute(s)** silent grace period, then **${warning} minute(s)** after the reminder before removal (total **${grace + warning} minute(s)**).`
        );
      } else if (sub === 'view') {
        const { graceMinutes, warningMinutes } = getTiming(interaction.guildId);
        await interaction.reply({
          content: `**Grace period:** ${graceMinutes} minute(s)\n**Warning period:** ${warningMinutes} minute(s)\n**Total time before removal:** ${graceMinutes + warningMinutes} minute(s)`,
          ephemeral: true,
        });
      }
    }

    if (interaction.commandName === 'camera-announcement') {
      const sub = interaction.options.getSubcommand();
      const guildConfig = ensureGuildConfig(interaction.guildId);

      if (sub === 'set') {
        const url = interaction.options.getString('url');
        guildConfig.announcementUrl = url;
        saveCameraConfig(cameraConfig);
        await interaction.reply(`✅ Announcement link set — it'll now be included in camera policy reminders.`);
      } else if (sub === 'clear') {
        guildConfig.announcementUrl = null;
        saveCameraConfig(cameraConfig);
        await interaction.reply(`✅ Announcement link cleared.`);
      } else if (sub === 'view') {
        await interaction.reply({
          content: guildConfig.announcementUrl ? `Current announcement link:\n${guildConfig.announcementUrl}` : 'No announcement link is set for this server.',
          ephemeral: true,
        });
      }
    }

    if (interaction.commandName === 'activity-tracker') {
      const group = interaction.options.getSubcommandGroup(false);
      const sub = interaction.options.getSubcommand();
      const guildConfig = ensureActivityGuildConfig(interaction.guildId);

      if (group === 'exempt-role') {
        if (sub === 'add') {
          const role = interaction.options.getRole('role');
          if (guildConfig.exemptRoleIds.includes(role.id)) {
            await interaction.reply({ content: `**${role.name}** is already exempt.`, ephemeral: true });
          } else {
            guildConfig.exemptRoleIds.push(role.id);
            saveActivityConfig(activityConfig);
            await interaction.reply(`✅ **${role.name}** is now exempt from activity tracking.`);
          }
        } else if (sub === 'remove') {
          const role = interaction.options.getRole('role');
          guildConfig.exemptRoleIds = guildConfig.exemptRoleIds.filter((id) => id !== role.id);
          saveActivityConfig(activityConfig);
          await interaction.reply(`✅ **${role.name}** is no longer exempt.`);
        } else if (sub === 'list') {
          const list = guildConfig.exemptRoleIds.length ? guildConfig.exemptRoleIds.map((id) => `<@&${id}>`).join('\n') : 'None set.';
          await interaction.reply({ content: `**Exempt roles:**\n${list}`, ephemeral: true });
        }
        return;
      }

      if (sub === 'enable') {
        if (!guildConfig.activeRoleId || !guildConfig.inactiveRoleId) {
          await interaction.reply({ content: '❌ Set your roles first with `/activity-tracker set-roles`.', ephemeral: true });
        } else {
          guildConfig.enabled = true;
          saveActivityConfig(activityConfig);
          await interaction.reply('✅ Activity tracking is now **ON**.');
          syncActivityRoles(interaction.guild); // run an immediate sync
        }
      } else if (sub === 'disable') {
        guildConfig.enabled = false;
        saveActivityConfig(activityConfig);
        await interaction.reply('📴 Activity tracking is now **OFF**.');
      } else if (sub === 'set-roles') {
        const active = interaction.options.getRole('active');
        const inactive = interaction.options.getRole('inactive');
        guildConfig.activeRoleId = active.id;
        guildConfig.inactiveRoleId = inactive.id;
        saveActivityConfig(activityConfig);
        await interaction.reply(`✅ Active role set to **${active.name}**, inactive role set to **${inactive.name}**.`);
      } else if (sub === 'set-threshold') {
        const days = interaction.options.getInteger('days');
        guildConfig.thresholdDays = days;
        saveActivityConfig(activityConfig);
        await interaction.reply(`✅ Inactivity threshold set to **${days} day(s)**.`);
      } else if (sub === 'set-quarantine-channel') {
        const channel = interaction.options.getChannel('channel');
        guildConfig.quarantineChannelId = channel.id;
        saveActivityConfig(activityConfig);
        await interaction.reply(
          `✅ Quarantine/reactivation channel set to **#${channel.name}**. Don't forget to set that channel's permissions (see setup guide) and run \`/activity-tracker post-button\`.`
        );
      } else if (sub === 'post-button') {
        if (!guildConfig.quarantineChannelId) {
          await interaction.reply({ content: '❌ Set a quarantine channel first with `/activity-tracker set-quarantine-channel`.', ephemeral: true });
        } else {
          const channel = await interaction.guild.channels.fetch(guildConfig.quarantineChannelId);
          const { embed, row } = buildReactivationEmbedAndRow();
          await channel.send({ embeds: [embed], components: [row] });
          await interaction.reply({ content: `✅ Button posted in **#${channel.name}**.`, ephemeral: true });
        }
      } else if (sub === 'status') {
        const embed = new EmbedBuilder()
          .setColor(guildConfig.enabled ? 0x00cc66 : 0x999999)
          .setTitle('Activity Tracker Status')
          .addFields(
            { name: 'Enabled', value: guildConfig.enabled ? 'Yes' : 'No', inline: true },
            { name: 'Threshold', value: `${guildConfig.thresholdDays} days`, inline: true },
            { name: 'Active role', value: guildConfig.activeRoleId ? `<@&${guildConfig.activeRoleId}>` : 'Not set', inline: true },
            { name: 'Inactive role', value: guildConfig.inactiveRoleId ? `<@&${guildConfig.inactiveRoleId}>` : 'Not set', inline: true },
            {
              name: 'Quarantine channel',
              value: guildConfig.quarantineChannelId ? `<#${guildConfig.quarantineChannelId}>` : 'Not set',
              inline: true,
            },
            {
              name: 'Exempt roles',
              value: guildConfig.exemptRoleIds.length ? guildConfig.exemptRoleIds.map((id) => `<@&${id}>`).join(', ') : 'None',
            }
          );
        await interaction.reply({ embeds: [embed], ephemeral: true });
      } else if (sub === 'check') {
        const user = interaction.options.getUser('user');
        const member = await interaction.guild.members.fetch(user.id);
        const activity = activityData[interaction.guildId]?.[user.id];
        const lastMessageAt = activity?.lastMessageAt || 0;
        const lastVoiceActiveAt = activity?.lastVoiceActiveAt || 0;
        const lastActive = Math.max(lastMessageAt, lastVoiceActiveAt, member.joinedTimestamp || 0);
        const daysSince = Math.floor((Date.now() - lastActive) / (24 * 60 * 60 * 1000));
        await interaction.reply({
          content:
            `**${user.tag}**\n` +
            `Last message: ${lastMessageAt ? `<t:${Math.floor(lastMessageAt / 1000)}:R>` : 'never recorded'}\n` +
            `Last voice activity: ${lastVoiceActiveAt ? `<t:${Math.floor(lastVoiceActiveAt / 1000)}:R>` : 'never recorded'}\n` +
            `Effectively last active: ${daysSince} day(s) ago\n` +
            `Currently: ${daysSince <= guildConfig.thresholdDays ? '🟢 Active' : '🔴 Inactive'}`,
          ephemeral: true,
        });
      }
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

// ============================================================
// Cameras-On voice channel policy — enforcement
// ============================================================
// Two-stage, low-noise design:
//   1. Camera goes off in a monitored channel -> a SILENT grace period
//      starts (default 2 min). Nothing is sent yet — this absorbs brief
//      flickers/reconnects without ever pinging anyone.
//   2. If still off when the grace period ends -> ONE reminder is posted
//      in the voice channel's own text chat (an @ping, not a DM), and a
//      second timer starts (default 3 min).
//   3. If still off when that timer ends -> they're disconnected from
//      voice and a short follow-up message is posted.
// Turning the camera on at any point cancels everything for that cycle.
// Turning it off again later starts a completely fresh cycle (matches
// "the timer will reset and you'll receive another reminder").

const warnedUsers = new Map(); // "guildId:userId" -> { stage: 'grace'|'warned', graceTimeoutId?, warnTimeoutId?, channel }

function warnKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function announcementLine(guildId) {
  const url = getAnnouncementUrl(guildId);
  return url ? `\n🔗 Policy details: <${url}>` : '';
}

async function handleCameraOff(member, channel) {
  const guildId = member.guild.id;
  const key = warnKey(guildId, member.id);

  // Already mid-cycle (grace or warned) — don't restart it
  if (warnedUsers.has(key)) return;

  const { graceMinutes, warningMinutes } = getTiming(guildId);
  const graceMs = graceMinutes * 60 * 1000;
  const warnMs = warningMinutes * 60 * 1000;

  const graceTimeoutId = setTimeout(async () => {
    try {
      // Re-check here, not just at the moment the toggle command ran — this
      // timer was scheduled possibly minutes ago, and the policy may have
      // been turned off since then. Without this check, a timer that's
      // already in-flight can fire and disconnect someone even after "off".
      if (!isCameraPolicyEnabled(guildId)) {
        warnedUsers.delete(key);
        return;
      }

      const currentVoiceChannel = member.voice?.channel;
      const stillInMonitoredChannel = currentVoiceChannel && getMonitoredChannels(guildId).includes(currentVoiceChannel.id);

      if (!stillInMonitoredChannel || member.voice.selfVideo) {
        warnedUsers.delete(key);
        return;
      }

      await currentVoiceChannel.send(
        `<@${member.id}> 📷 Please enable your camera — you have **${warningMinutes} minute(s)** before you'll be moved out of ${currentVoiceChannel}.${announcementLine(guildId)}`
      );

      const warnTimeoutId = setTimeout(async () => {
        try {
          // Same re-check — this timer can fire minutes after it was set,
          // long after an admin may have turned the policy off.
          if (!isCameraPolicyEnabled(guildId)) {
            warnedUsers.delete(key);
            return;
          }

          const cvc = member.voice?.channel;
          const stillIn = cvc && getMonitoredChannels(guildId).includes(cvc.id);

          if (stillIn && !member.voice.selfVideo) {
            await member.voice.disconnect('Camera not enabled within the warning period');
            await cvc.send(`<@${member.id}> ❌ You were moved out for not enabling your camera. Feel free to rejoin anytime with it on!`);
          }
        } catch (err) {
          console.error('Error enforcing camera-off removal:', err.message);
        } finally {
          warnedUsers.delete(key);
        }
      }, warnMs);

      warnedUsers.set(key, { stage: 'warned', warnTimeoutId, channel: currentVoiceChannel });
    } catch (err) {
      console.error('Error sending camera reminder:', err.message);
      warnedUsers.delete(key);
    }
  }, graceMs);

  warnedUsers.set(key, { stage: 'grace', graceTimeoutId, channel });
}

async function clearWarning(guildId, userId, { confirm = true } = {}) {
  const key = warnKey(guildId, userId);
  const info = warnedUsers.get(key);
  if (!info) return;

  if (info.graceTimeoutId) clearTimeout(info.graceTimeoutId);
  if (info.warnTimeoutId) clearTimeout(info.warnTimeoutId);
  warnedUsers.delete(key);

  // Only post a confirmation if we'd actually sent a reminder — no need to
  // say anything if they turned the camera on during the silent grace period
  if (confirm && info.stage === 'warned' && info.channel) {
    try {
      await info.channel.send(`<@${userId}> ✅ Thanks for turning your camera on!`);
    } catch (err) {
      console.error('Could not send camera confirmation:', err.message);
    }
  }
}

client.on('voiceStateUpdate', async (oldState, newState) => {
  const guildId = newState.guild.id;
  if (!isCameraPolicyEnabled(guildId)) return;

  const channelId = newState.channelId;
  const memberId = newState.member.id;

  if (!channelId || !getMonitoredChannels(guildId).includes(channelId)) {
    // Left voice entirely, or moved to an unmonitored channel — clear
    // silently (no "thanks!" message, since they're not even there anymore)
    if (!newState.channelId) {
      await clearWarning(guildId, memberId, { confirm: false });
    }
    return;
  }

  const member = newState.member;
  const channel = newState.channel;
  const cameraIsOn = newState.selfVideo;
  const key = warnKey(guildId, memberId);

  // If they moved between two monitored channels while already mid-cycle,
  // keep the reminder/removal messages pointed at their CURRENT channel
  if (warnedUsers.has(key)) {
    warnedUsers.get(key).channel = channel;
  }

  const isExempt = member.roles.cache.some((role) => getExemptRoles(guildId).includes(role.id));
  if (isExempt) {
    await clearWarning(guildId, memberId, { confirm: false });
    return;
  }

  if (!cameraIsOn) {
    await handleCameraOff(member, channel);
  } else {
    await clearWarning(guildId, memberId, { confirm: true });
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
