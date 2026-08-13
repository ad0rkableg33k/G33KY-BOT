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
  StringSelectMenuBuilder,
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
const DEFAULT_RETENTION_DAYS = 90; // how long a raw activity timestamp is kept before being purged entirely
const DEFAULT_VOICE_MINUTES_REQUIRED = 1; // continuous minutes in a single voice session before it counts as activity

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
      retentionDays: DEFAULT_RETENTION_DAYS,
      channelRestrictionsApplied: false,
      voiceMinutesRequired: DEFAULT_VOICE_MINUTES_REQUIRED,
    };
  }
  // Normalize configs saved before these fields existed
  if (activityConfig[guildId].monitoredChannels === undefined) {
    activityConfig[guildId].monitoredChannels = [];
  }
  if (activityConfig[guildId].retentionDays === undefined) {
    activityConfig[guildId].retentionDays = DEFAULT_RETENTION_DAYS;
  }
  if (activityConfig[guildId].voiceMinutesRequired === undefined) {
    activityConfig[guildId].voiceMinutesRequired = DEFAULT_VOICE_MINUTES_REQUIRED;
  }
  if (activityConfig[guildId].channelRestrictionsApplied === undefined) {
    activityConfig[guildId].channelRestrictionsApplied = false;
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
  try {
    fs.writeFileSync(ACTIVITY_DATA_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.error(`Failed to save activity-data.json to ${ACTIVITY_DATA_FILE}:`, err.message);
    return false;
  }
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

function voiceMsRequired(cfg) {
  return (cfg.voiceMinutesRequired ?? DEFAULT_VOICE_MINUTES_REQUIRED) * 60 * 1000;
}

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
  if (Date.now() - session.joinedAt >= voiceMsRequired(cfg)) {
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

// ---- Reconciliation: credit anyone CURRENTLY connected to voice ----
// The join/leave tracking above only sees people who join *while the bot
// is running*. If someone is already mid-call at the exact moment the bot
// restarts (which happens on every redeploy), the bot never sees a "join"
// for them — so when they eventually leave, there's no session to close
// and their voice time silently goes uncounted, no matter how long they
// were actually connected. This directly scans who's really in voice right
// now (via Discord's own live state, not our possibly-stale in-memory map)
// and credits them outright, then refreshes their session so join/leave
// tracking stays consistent going forward. Runs once at startup — so a
// redeploy can never erase someone's in-progress call — and on the same
// periodic schedule as the sweep below, so it's self-healing against any
// future missed events too (e.g. a brief Gateway reconnect gap).
async function reconcileConnectedVoiceMembers() {
  let totalCredited = 0;
  for (const guild of client.guilds.cache.values()) {
    try {
      await guild.members.fetch();
    } catch (err) {
      console.error(`[activity-voice] Failed to fetch members for guild ${guild.id} — reconciliation skipped this guild this pass:`, err.message);
      continue;
    }
    const cfg = ensureActivityGuildConfig(guild.id);
    for (const channel of guild.channels.cache.values()) {
      if (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice) continue;
      if (cfg.monitoredChannels.length && !cfg.monitoredChannels.includes(channel.id)) continue;
      for (const member of channel.members.values()) {
        if (member.user.bot) continue;
        markVoiceActive(guild.id, member.id);
        activityVoiceSessions.set(`${guild.id}:${member.id}`, { joinedAt: Date.now(), channelId: channel.id });
        totalCredited++;
      }
    }
  }
  console.log(`[activity-voice] Reconciliation pass: credited ${totalCredited} member(s) currently connected to voice.`);
  return totalCredited;
}

// Sweep every 5 min: reconcile who's actually connected right now (fixes
// the restart edge case above and self-heals missed events), and also
// finalize any tracked session that's crossed each guild's configured
// voice-minutes threshold.
setInterval(async () => {
  await reconcileConnectedVoiceMembers();
  const now = Date.now();
  for (const [key, session] of activityVoiceSessions.entries()) {
    const [guildId, userId] = key.split(':');
    const cfg = ensureActivityGuildConfig(guildId);
    if (now - session.joinedAt < voiceMsRequired(cfg)) continue;
    if (cfg.monitoredChannels.length && !cfg.monitoredChannels.includes(session.channelId)) continue;
    markVoiceActive(guildId, userId);
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
  if (!config.enabled) {
    console.log(`[activity-sync] Skipping ${guild.id} — activity tracking is disabled for this server.`);
    return;
  }
  if (!config.activeRoleId || !config.inactiveRoleId) {
    console.log(`[activity-sync] Skipping ${guild.id} — Active and/or Inactive role isn't set yet.`);
    return;
  }

  const thresholdMs = config.thresholdDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  let members;
  try {
    members = await guild.members.fetch();
  } catch (err) {
    console.error(`[activity-sync] Failed to fetch members for guild ${guild.id} — sync aborted this pass:`, err.message);
    return;
  }

  let madeActive = 0;
  let madeInactive = 0;
  let failed = 0;

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
        if (!member.roles.cache.has(config.activeRoleId)) {
          await member.roles.add(config.activeRoleId);
          madeActive++;
        }
        if (member.roles.cache.has(config.inactiveRoleId)) await member.roles.remove(config.inactiveRoleId);
      } else {
        if (!member.roles.cache.has(config.inactiveRoleId)) {
          await member.roles.add(config.inactiveRoleId);
          madeInactive++;
        }
        if (member.roles.cache.has(config.activeRoleId)) await member.roles.remove(config.activeRoleId);
      }
    } catch (err) {
      failed++;
      console.error(`[activity-sync] Role update failed for member ${member.id} in ${guild.id}:`, err.message);
    }
  }

  console.log(`[activity-sync] ${guild.id}: checked ${members.size} member(s) — ${madeActive} newly Active, ${madeInactive} newly Inactive, ${failed} failed.`);
}

async function syncAllActivityGuilds() {
  for (const guild of client.guilds.cache.values()) {
    await syncActivityRoles(guild);
  }
}

// ---- Channel restrictions: lock the Inactive role out of every channel
// except the quarantine/reactivation one. This is an explicit, admin-
// triggered action (never automatic) since it edits permission overwrites
// across the entire server — a consequential, bulk change that shouldn't
// ever happen silently. Once applied, newly created channels are locked
// down automatically too (see the channelCreate listener below), so the
// admin doesn't have to remember to re-run this every time a channel gets
// added.
async function applyInactiveChannelRestrictions(guild) {
  const cfg = ensureActivityGuildConfig(guild.id);
  if (!cfg.inactiveRoleId || !cfg.quarantineChannelId) {
    return { success: false, reason: 'Set both the Inactive role and the quarantine channel first.' };
  }

  let updated = 0;
  const failed = [];

  for (const channel of guild.channels.cache.values()) {
    if (channel.type === ChannelType.GuildCategory) continue;
    if (channel.isThread?.()) continue; // threads inherit from their parent channel, no overwrites of their own

    const isQuarantineChannel = channel.id === cfg.quarantineChannelId;
    try {
      if (isQuarantineChannel) {
        await channel.permissionOverwrites.edit(cfg.inactiveRoleId, {
          ViewChannel: true,
          ReadMessageHistory: true,
          SendMessages: true,
        });
      } else {
        await channel.permissionOverwrites.edit(cfg.inactiveRoleId, {
          ViewChannel: false,
          SendMessages: false,
          ReadMessageHistory: false,
        });
      }
      updated++;
    } catch (err) {
      failed.push({ channelId: channel.id, name: channel.name, error: err.message });
    }
  }

  cfg.channelRestrictionsApplied = true;
  saveActivityConfig(activityConfig);

  if (failed.length > 0) {
    console.error(
      `[activity-restrictions] ${guild.id}: updated ${updated} channel(s), failed on ${failed.length}: ${failed.map((f) => `#${f.name} (${f.error})`).join('; ')}`
    );
  }

  return { success: true, updated, failed };
}

// Once an admin has applied restrictions at least once, keep every NEW
// channel locked down the same way automatically — otherwise every channel
// created after that point would be visible to Inactive members by default
// until someone remembered to re-run the apply action.
client.on('channelCreate', async (channel) => {
  if (!channel.guild) return;
  if (channel.type === ChannelType.GuildCategory) return;
  const cfg = ensureActivityGuildConfig(channel.guild.id);
  if (!cfg.channelRestrictionsApplied || !cfg.inactiveRoleId || !cfg.quarantineChannelId) return;
  if (channel.id === cfg.quarantineChannelId) return;
  try {
    await channel.permissionOverwrites.edit(cfg.inactiveRoleId, {
      ViewChannel: false,
      SendMessages: false,
      ReadMessageHistory: false,
    });
  } catch (err) {
    console.error(`Failed to auto-apply Inactive role restriction to new channel #${channel.name} (${channel.id}):`, err.message);
  }
});

// ---- Data retention: automatically purge raw activity timestamps once
// they're older than each guild's configured retention window (default 90
// days). This is separate from thresholdDays (which only decides the
// Active/Inactive role) — retentionDays decides how long the underlying
// lastMessageAt/lastVoiceActiveAt record is kept on disk at all, so the
// bot doesn't hold onto member activity data indefinitely.
//
// A record's age is based on whichever is more recent: their last message,
// their last qualifying voice time, or nothing (0) if neither ever
// happened — that last case gets purged immediately since there's nothing
// meaningful stored. Deleting a record does NOT change anyone's current
// Active/Inactive role; it only removes the historical timestamp once it's
// past the point where it could still be used to prove recent activity.
function pruneActivityData(onlyGuildId = null) {
  const now = Date.now();
  let prunedCount = 0;
  let guildsAffected = 0;

  const guildIds = onlyGuildId ? [onlyGuildId] : Object.keys(activityData);
  for (const guildId of guildIds) {
    if (!activityData[guildId]) continue;
    const cfg = ensureActivityGuildConfig(guildId);
    const retentionMs = (cfg.retentionDays ?? DEFAULT_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
    const guildRecords = activityData[guildId];
    let guildPruned = 0;

    for (const userId of Object.keys(guildRecords)) {
      const record = guildRecords[userId];
      const lastActive = Math.max(record.lastMessageAt || 0, record.lastVoiceActiveAt || 0);
      if (lastActive === 0 || now - lastActive > retentionMs) {
        delete guildRecords[userId];
        guildPruned++;
      }
    }

    if (guildPruned > 0) {
      prunedCount += guildPruned;
      guildsAffected++;
    }
    if (Object.keys(guildRecords).length === 0) delete activityData[guildId];
  }

  if (prunedCount > 0) {
    saveActivityData(activityData);
    console.log(`[activity-retention] Purged ${prunedCount} stale activity record(s) across ${guildsAffected} server(s).`);
  }

  return prunedCount;
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
    .setTitle('⚙️ G33KY Bot Configuration')
    .setDescription('Select a module to configure below. Everything saves instantly — no need to type commands.');

  const moduleSelect = new StringSelectMenuBuilder()
    .setCustomId('setup:main:select')
    .setPlaceholder('Select a module to configure...')
    .addOptions(
      { label: 'Camera Policy', description: 'Cameras-on voice channel policy', value: 'camera', emoji: '📷' },
      { label: 'Activity Tracker', description: 'Track member activity & auto-role members', value: 'activity', emoji: '📊' },
      { label: 'Category Permissions', description: 'Bulk-apply role perms across categories', value: 'catperms', emoji: '🔐' }
    );

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(moduleSelect)] };
}

function buildCameraMenuMessage(guildId) {
  const cfg = ensureGuildConfig(guildId);

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle('📷 Camera Policy Configuration')
    .setDescription(
      `**Status:** ${cfg.enabled ? '🟢 Enabled' : '🔴 Disabled'}\n` +
        `**Timing:** ${cfg.graceMinutes ?? DEFAULT_GRACE_MINUTES}m grace + ${cfg.warningMinutes ?? DEFAULT_WARNING_MINUTES}m warning\n` +
        `**Announcement:** ${cfg.announcementUrl ? `[view post](${cfg.announcementUrl})` : 'Not posted yet'}\n` +
        `**Monitored Channels:** ${cfg.monitoredChannels.length ? cfg.monitoredChannels.map((id) => `<#${id}>`).join(', ') : 'Not set'}\n` +
        `**Exempt Roles:** ${cfg.exemptRoles.length ? cfg.exemptRoles.map((id) => `<@&${id}>`).join(', ') : 'Not set'}`
    );

  const topRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('setup:camera:toggle')
      .setLabel(cfg.enabled ? 'Disable' : 'Enable')
      .setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('setup:camera:announce-post').setLabel('Post Policy Announcement').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('setup:camera:timing').setLabel('Set Timing').setStyle(ButtonStyle.Secondary)
  );

  const bottomRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:camera:create-exempt-role').setLabel('Create Exempt Role').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:main').setLabel('⬅ Back to Modules').setStyle(ButtonStyle.Secondary)
  );

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('setup:camera:channels:select')
    .setPlaceholder('Select monitored voice channels...')
    .setChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
    .setMinValues(0)
    .setMaxValues(25);
  if (cfg.monitoredChannels.length) channelSelect.setDefaultChannels(...cfg.monitoredChannels.slice(0, 25));

  const roleSelect = new RoleSelectMenuBuilder()
    .setCustomId('setup:camera:exempt:select')
    .setPlaceholder('Select the exempt role(s)...')
    .setMinValues(0)
    .setMaxValues(25);
  if (cfg.exemptRoles.length) roleSelect.setDefaultRoles(...cfg.exemptRoles.slice(0, 25));

  const announceChannelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('setup:camera:announce-channel:select')
    .setPlaceholder('Select the announcement channel...')
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    .setMinValues(0)
    .setMaxValues(1);
  if (cfg.announcementChannelId) announceChannelSelect.setDefaultChannels(cfg.announcementChannelId);

  return {
    embeds: [embed],
    components: [
      topRow,
      bottomRow,
      new ActionRowBuilder().addComponents(channelSelect),
      new ActionRowBuilder().addComponents(roleSelect),
      new ActionRowBuilder().addComponents(announceChannelSelect),
    ],
  };
}

// ---- Activity tracker menu: split across 3 pages (main / roles / channels)
// because Discord caps messages at 5 component rows and this feature has
// more pickers than camera policy does.
function buildActivityMenuMessage(guildId) {
  const cfg = ensureActivityGuildConfig(guildId);

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle('📊 Activity Tracker Configuration')
    .setDescription(
      `**Status:** ${cfg.enabled ? '🟢 Enabled' : '🔴 Disabled'}\n` +
        `**Threshold:** ${cfg.thresholdDays} days\n` +
        `**Voice minutes required:** ${cfg.voiceMinutesRequired ?? DEFAULT_VOICE_MINUTES_REQUIRED} continuous minute(s)\n` +
        `**Retention:** ${cfg.retentionDays ?? DEFAULT_RETENTION_DAYS} days (records auto-deleted after this)\n` +
        `**Quarantine Channel:** ${cfg.quarantineChannelId ? `<#${cfg.quarantineChannelId}>` : 'Not set'}\n` +
        `**Active Role:** ${cfg.activeRoleId ? `<@&${cfg.activeRoleId}>` : 'Not set'}\n` +
        `**Inactive Role:** ${cfg.inactiveRoleId ? `<@&${cfg.inactiveRoleId}>` : 'Not set'}\n` +
        `**Exempt Roles:** ${cfg.exemptRoleIds.length ? cfg.exemptRoleIds.map((id) => `<@&${id}>`).join(', ') : 'Not set'}\n` +
        `**Monitored Channels:** ${cfg.monitoredChannels.length ? cfg.monitoredChannels.map((id) => `<#${id}>`).join(', ') : 'All channels (default)'}`
    );

  const topRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('setup:activity:toggle')
      .setLabel(cfg.enabled ? 'Disable' : 'Enable')
      .setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('setup:activity:postbutton').setLabel('Post Reactivation Button').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('setup:activity:threshold').setLabel('Set Threshold / Retention').setStyle(ButtonStyle.Secondary)
  );

  const bottomRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:activity:roles-menu').setLabel('🎭 Configure Roles').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:activity:channels-menu').setLabel('# Configure Channels').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:main').setLabel('⬅ Back to Modules').setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [topRow, bottomRow] };
}

function buildActivityRolesMenuMessage(guildId) {
  const cfg = ensureActivityGuildConfig(guildId);

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle('📊 Activity Tracker — Roles')
    .setDescription(
      `**Active Role:** ${cfg.activeRoleId ? `<@&${cfg.activeRoleId}>` : 'Not set'}\n` +
        `**Inactive Role:** ${cfg.inactiveRoleId ? `<@&${cfg.inactiveRoleId}>` : 'Not set'}\n` +
        `**Exempt Roles:** ${cfg.exemptRoleIds.length ? cfg.exemptRoleIds.map((id) => `<@&${id}>`).join(', ') : 'Not set'}`
    );

  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:activity:create-active-role').setLabel('Create Active Role').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:activity:create-inactive-role').setLabel('Create Inactive Role').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:activity:create-exempt-role').setLabel('Create Exempt Role').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:activity:menu').setLabel('⬅ Back').setStyle(ButtonStyle.Secondary)
  );

  const activeRoleSelect = new RoleSelectMenuBuilder().setCustomId('setup:activity:activerole:select').setPlaceholder('Select the active role...').setMinValues(1).setMaxValues(1);
  if (cfg.activeRoleId) activeRoleSelect.setDefaultRoles(cfg.activeRoleId);

  const inactiveRoleSelect = new RoleSelectMenuBuilder().setCustomId('setup:activity:inactiverole:select').setPlaceholder('Select the inactive role...').setMinValues(1).setMaxValues(1);
  if (cfg.inactiveRoleId) inactiveRoleSelect.setDefaultRoles(cfg.inactiveRoleId);

  const exemptSelect = new RoleSelectMenuBuilder().setCustomId('setup:activity:exempt:select').setPlaceholder('Select the exempt role(s)...').setMinValues(0).setMaxValues(25);
  if (cfg.exemptRoleIds.length) exemptSelect.setDefaultRoles(...cfg.exemptRoleIds.slice(0, 25));

  return {
    embeds: [embed],
    components: [
      buttonRow,
      new ActionRowBuilder().addComponents(activeRoleSelect),
      new ActionRowBuilder().addComponents(inactiveRoleSelect),
      new ActionRowBuilder().addComponents(exemptSelect),
    ],
  };
}

function buildActivityChannelsMenuMessage(guildId) {
  const cfg = ensureActivityGuildConfig(guildId);

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle('📊 Activity Tracker — Channels')
    .setDescription(
      `**Quarantine / Reactivation Channel:** ${cfg.quarantineChannelId ? `<#${cfg.quarantineChannelId}>` : 'Not set'}\n` +
        `**Monitored Channels:** ${
          cfg.monitoredChannels.length ? cfg.monitoredChannels.map((id) => `<#${id}>`).join(', ') : 'All channels (default)'
        }\n` +
        `**Channel Restrictions:** ${
          cfg.channelRestrictionsApplied
            ? '🔒 Applied — Inactive is locked out everywhere except the quarantine channel, and new channels are locked down automatically'
            : '🔓 Not applied — Inactive can currently see every channel like any other member'
        }`
    );

  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:activity:create-quarantine-channel').setLabel('Create Reactivation Channel').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:activity:apply-restrictions').setLabel('🔒 Apply Channel Restrictions').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('setup:activity:menu').setLabel('⬅ Back').setStyle(ButtonStyle.Secondary)
  );

  const quarantineSelect = new ChannelSelectMenuBuilder()
    .setCustomId('setup:activity:quarantine:select')
    .setPlaceholder('Select the reactivation channel...')
    .setChannelTypes(ChannelType.GuildText)
    .setMinValues(1)
    .setMaxValues(1);
  if (cfg.quarantineChannelId) quarantineSelect.setDefaultChannels(cfg.quarantineChannelId);

  const monitoredSelect = new ChannelSelectMenuBuilder()
    .setCustomId('setup:activity:channels:select')
    .setPlaceholder('Select channels to track (empty = everywhere)...')
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice)
    .setMinValues(0)
    .setMaxValues(25);
  if (cfg.monitoredChannels.length) monitoredSelect.setDefaultChannels(...cfg.monitoredChannels.slice(0, 25));

  return {
    embeds: [embed],
    components: [buttonRow, new ActionRowBuilder().addComponents(quarantineSelect), new ActionRowBuilder().addComponents(monitoredSelect)],
  };
}

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'setup') {
      return interaction.reply({ ...buildMainMenuMessage(), ephemeral: true });
    }

    if (!interaction.customId || !interaction.customId.startsWith('setup:')) return;
    if (
      !interaction.isButton() &&
      !interaction.isRoleSelectMenu() &&
      !interaction.isChannelSelectMenu() &&
      !interaction.isStringSelectMenu() &&
      !interaction.isModalSubmit()
    )
      return;

    const guildId = interaction.guildId;
    const id = interaction.customId;

    // ---- Navigation ----
    if (id === 'setup:main') return interaction.update(buildMainMenuMessage());
    if (id === 'setup:main:select') {
      const choice = interaction.values[0];
      if (choice === 'camera') return interaction.update(buildCameraMenuMessage(guildId));
      if (choice === 'activity') return interaction.update(buildActivityMenuMessage(guildId));
      if (choice === 'catperms') {
        return interaction.reply({ content: '🔐 **Category Permissions** is managed from the web dashboard — head to the **Category Perms** tab to build templates and apply them! You can also use `/category-perms apply`, `/category-perms unsync`, and `/category-perms list-templates` from Discord directly.', ephemeral: true });
      }
      return;
    }
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
      const modal = new ModalBuilder().setCustomId('setup:activity:threshold:modal').setTitle('Threshold & Data Retention');
      const daysInput = new TextInputBuilder()
        .setCustomId('days')
        .setLabel('Days of inactivity before "Inactive"')
        .setStyle(TextInputStyle.Short)
        .setValue(String(cfg.thresholdDays))
        .setRequired(true);
      const retentionInput = new TextInputBuilder()
        .setCustomId('retention')
        .setLabel('Delete activity records after (days)')
        .setStyle(TextInputStyle.Short)
        .setValue(String(cfg.retentionDays ?? DEFAULT_RETENTION_DAYS))
        .setRequired(true);
      const voiceMinutesInput = new TextInputBuilder()
        .setCustomId('voiceMinutes')
        .setLabel('Continuous voice minutes to count as active')
        .setStyle(TextInputStyle.Short)
        .setValue(String(cfg.voiceMinutesRequired ?? DEFAULT_VOICE_MINUTES_REQUIRED))
        .setRequired(true);
      modal.addComponents(
        new ActionRowBuilder().addComponents(daysInput),
        new ActionRowBuilder().addComponents(retentionInput),
        new ActionRowBuilder().addComponents(voiceMinutesInput)
      );
      return interaction.showModal(modal);
    }

    if (id === 'setup:activity:threshold:modal') {
      const days = parseInt(interaction.fields.getTextInputValue('days'), 10);
      const retention = parseInt(interaction.fields.getTextInputValue('retention'), 10);
      const voiceMinutes = parseInt(interaction.fields.getTextInputValue('voiceMinutes'), 10);
      if (!Number.isInteger(days) || days < 1) {
        return interaction.reply({ content: '❌ Threshold must be a whole number of days, 1 or more.', ephemeral: true });
      }
      if (!Number.isInteger(retention) || retention < 1) {
        return interaction.reply({ content: '❌ Retention must be a whole number of days, 1 or more.', ephemeral: true });
      }
      if (retention < days) {
        return interaction.reply({
          content: `❌ Retention (${retention} days) can't be shorter than the threshold (${days} days) — that would delete activity records before they're used to decide Active/Inactive.`,
          ephemeral: true,
        });
      }
      if (!Number.isInteger(voiceMinutes) || voiceMinutes < 1) {
        return interaction.reply({ content: '❌ Voice minutes must be a whole number, 1 or more.', ephemeral: true });
      }
      const cfg = ensureActivityGuildConfig(guildId);
      cfg.thresholdDays = days;
      cfg.retentionDays = retention;
      cfg.voiceMinutesRequired = voiceMinutes;
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
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
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

    if (id === 'setup:activity:apply-restrictions') {
      await interaction.deferUpdate(); // this can take a few seconds on a server with many channels
      const result = await applyInactiveChannelRestrictions(interaction.guild);
      if (!result.success) {
        await interaction.followUp({ content: `❌ ${result.reason}`, ephemeral: true });
        return;
      }
      await interaction.editReply(buildActivityChannelsMenuMessage(guildId));
      const failedNote = result.failed.length > 0 ? `\n⚠️ Failed on ${result.failed.length} channel(s) — check the bot has **Manage Roles** and can see those channels.` : '';
      await interaction.followUp({
        content: `🔒 Applied to **${result.updated}** channel(s). Inactive is now locked out everywhere except the quarantine channel, and any channel created from now on will be locked down automatically.${failedNote}`,
        ephemeral: true,
      });
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

// ---- Channel-index config: per-guild, editable via the dashboard ----
// Used to be hardcoded constants (single-guild only). Now stored in
// channel-index-config.json, same pattern as camera-config.json /
// activity-config.json, and seeded once from the original hardcoded values
// below so xXOnlineStatusXx's existing exclusions aren't lost.
const CHANNEL_INDEX_CONFIG_FILE = dataPath('channel-index-config.json');

const LEGACY_SEED_EXCLUDED_CATEGORY_IDS = [
  '1517124026756235294', // ✦ ₊ ˚ xX☆ѕтαƒƒ ѕтuƒƒ☆Xx ˚ ₊ ✦
  '1494265392338702377',
  '1522368511123525754',
  '1522167743237984336',
];
const LEGACY_SEED_EXCLUDED_CHANNEL_IDS = ['1533592609623376095', '1521265292070752286'];
const LEGACY_SEED_EXCLUDED_NAME_KEYWORDS = ['ticket'];

function loadChannelIndexConfig() {
  try {
    return JSON.parse(fs.readFileSync(CHANNEL_INDEX_CONFIG_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveChannelIndexConfig(config) {
  try {
    fs.writeFileSync(CHANNEL_INDEX_CONFIG_FILE, JSON.stringify(config, null, 2));
    return true;
  } catch (err) {
    console.error(`Failed to save channel-index-config.json to ${CHANNEL_INDEX_CONFIG_FILE}:`, err.message);
    return false;
  }
}

let channelIndexConfig = loadChannelIndexConfig();

function ensureChannelIndexGuildConfig(guildId) {
  if (!channelIndexConfig[guildId]) {
    // One-time seed: only the original guild inherits the old hardcoded
    // exclusions; every other/new guild starts with a clean slate.
    const isOriginalGuild = guildId === GUILD_ID;
    channelIndexConfig[guildId] = {
      excludedCategoryIds: isOriginalGuild ? [...LEGACY_SEED_EXCLUDED_CATEGORY_IDS] : [],
      excludedChannelIds: isOriginalGuild ? [...LEGACY_SEED_EXCLUDED_CHANNEL_IDS] : [],
      excludedNameKeywords: isOriginalGuild ? [...LEGACY_SEED_EXCLUDED_NAME_KEYWORDS] : [],
    };
    saveChannelIndexConfig(channelIndexConfig);
  }
  return channelIndexConfig[guildId];
}

// ============================================================
// Category Permissions — bulk apply role permission overwrites
// across one or more categories (and optionally their child channels),
// with reusable saved templates per guild.
// ============================================================
const CATEGORY_PERMS_CONFIG_FILE = dataPath('category-perms-config.json');

// The permission flags we expose in the UI — full set covering general
// access, text, moderation, and voice permissions.
const MANAGED_PERMS = [
  // ── General ──
  { key: 'ViewChannel',               label: '👁️  View Channel',                  group: 'General' },
  { key: 'ManageChannels',            label: '🔧 Manage Channels',                group: 'General' },
  { key: 'ManageRoles',               label: '🎭 Manage Roles (Channel Perms)',   group: 'General' },
  { key: 'ManageWebhooks',            label: '🪝 Manage Webhooks',                group: 'General' },
  { key: 'CreateInvite',              label: '✉️  Create Invite',                  group: 'General' },
  // ── Text ──
  { key: 'SendMessages',              label: '💬 Send Messages',                  group: 'Text' },
  { key: 'SendMessagesInThreads',     label: '🧵 Send Messages in Threads',       group: 'Text' },
  { key: 'CreatePublicThreads',       label: '🧵 Create Public Threads',          group: 'Text' },
  { key: 'CreatePrivateThreads',      label: '🔒 Create Private Threads',         group: 'Text' },
  { key: 'ManageMessages',            label: '🗑️  Manage Messages',                group: 'Text' },
  { key: 'ManageThreads',             label: '🗑️  Manage Threads',                 group: 'Text' },
  { key: 'ReadMessageHistory',        label: '📜 Read Message History',           group: 'Text' },
  { key: 'AddReactions',              label: '😀 Add Reactions',                  group: 'Text' },
  { key: 'UseExternalEmojis',         label: '🌐 Use External Emojis',            group: 'Text' },
  { key: 'UseExternalStickers',       label: '🌐 Use External Stickers',          group: 'Text' },
  { key: 'MentionEveryone',           label: '📢 Mention @everyone / @here',      group: 'Text' },
  { key: 'EmbedLinks',                label: '🔗 Embed Links',                    group: 'Text' },
  { key: 'AttachFiles',               label: '📎 Attach Files',                   group: 'Text' },
  { key: 'UseApplicationCommands',    label: '🤖 Use Application Commands',       group: 'Text' },
  { key: 'SendTTSMessages',           label: '🔊 Send TTS Messages',              group: 'Text' },
  // ── Moderation ──
  { key: 'KickMembers',               label: '👢 Kick Members',                   group: 'Moderation' },
  { key: 'BanMembers',                label: '🔨 Ban Members',                    group: 'Moderation' },
  { key: 'ModerateMembers',           label: '⏱️  Timeout Members',               group: 'Moderation' },
  { key: 'ViewAuditLog',              label: '📋 View Audit Log',                 group: 'Moderation' },
  // ── Voice ──
  { key: 'Connect',                   label: '🎙️  Connect',                        group: 'Voice' },
  { key: 'Speak',                     label: '🔊 Speak',                          group: 'Voice' },
  { key: 'Stream',                    label: '🎥 Stream / Go Live',               group: 'Voice' },
  { key: 'UseEmbeddedActivities',     label: '🎮 Use Activities',                 group: 'Voice' },
  { key: 'UseVAD',                    label: '🎤 Use Voice Activity (no PTT)',     group: 'Voice' },
  { key: 'PrioritySpeaker',           label: '⭐ Priority Speaker',               group: 'Voice' },
  { key: 'MuteMembers',               label: '🔇 Mute Members',                   group: 'Voice' },
  { key: 'DeafenMembers',             label: '🙉 Deafen Members',                 group: 'Voice' },
  { key: 'MoveMembers',               label: '↔️  Move Members',                   group: 'Voice' },
];

function loadCategoryPermsConfig() {
  try {
    return JSON.parse(fs.readFileSync(CATEGORY_PERMS_CONFIG_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveCategoryPermsConfig(config) {
  try {
    fs.writeFileSync(CATEGORY_PERMS_CONFIG_FILE, JSON.stringify(config, null, 2));
    return true;
  } catch (err) {
    console.error(`Failed to save category-perms-config.json to ${CATEGORY_PERMS_CONFIG_FILE}:`, err.message);
    return false;
  }
}

let categoryPermsConfig = loadCategoryPermsConfig();

function ensureCategoryPermsGuildConfig(guildId) {
  if (!categoryPermsConfig[guildId]) {
    categoryPermsConfig[guildId] = { templates: [] };
    saveCategoryPermsConfig(categoryPermsConfig);
  }
  return categoryPermsConfig[guildId];
}

// Apply a template to one or more categories.
// cascade=true also applies to every child channel inside each category.
// Returns { updated, failed[] }
async function applyCategoryPermsTemplate(guild, template, categoryIds, cascade) {
  let updated = 0;
  const failed = [];

  for (const catId of categoryIds) {
    const category = guild.channels.cache.get(catId);
    if (!category || category.type !== ChannelType.GuildCategory) {
      failed.push({ id: catId, name: catId, error: 'Not a category or not found' });
      continue;
    }

    for (const rolePerms of template.rolePerms) {
      const overwrite = {};
      for (const [perm, val] of Object.entries(rolePerms.perms)) {
        if (val === 'allow') overwrite[perm] = true;
        else if (val === 'deny') overwrite[perm] = false;
        // 'neutral' = omit from overwrite object (inherits)
      }
      try {
        await category.permissionOverwrites.edit(rolePerms.roleId, overwrite);
        updated++;
      } catch (err) {
        failed.push({ id: catId, name: category.name, error: err.message });
      }

      if (cascade) {
        const children = guild.channels.cache.filter((c) => c.parentId === catId && c.type !== ChannelType.GuildCategory);
        for (const child of children.values()) {
          try {
            await child.permissionOverwrites.edit(rolePerms.roleId, overwrite);
            updated++;
          } catch (err) {
            failed.push({ id: child.id, name: child.name, error: err.message });
          }
        }
      }
    }
  }

  return { updated, failed };
}

// Remove ALL permission overwrites for a set of role IDs from the given
// category IDs (and optionally their child channels).
async function unsyncCategoryPerms(guild, roleIds, categoryIds, cascade) {
  let updated = 0;
  const failed = [];

  for (const catId of categoryIds) {
    const category = guild.channels.cache.get(catId);
    if (!category || category.type !== ChannelType.GuildCategory) {
      failed.push({ id: catId, name: catId, error: 'Not a category or not found' });
      continue;
    }

    for (const roleId of roleIds) {
      try {
        await category.permissionOverwrites.delete(roleId);
        updated++;
      } catch (err) {
        failed.push({ id: catId, name: category.name, error: err.message });
      }

      if (cascade) {
        const children = guild.channels.cache.filter((c) => c.parentId === catId && c.type !== ChannelType.GuildCategory);
        for (const child of children.values()) {
          try {
            await child.permissionOverwrites.delete(roleId);
            updated++;
          } catch (err) {
            failed.push({ id: child.id, name: child.name, error: err.message });
          }
        }
      }
    }
  }

  return { updated, failed };
}

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
    .setName('setup')
    .setDescription('Open the G33KY Bot configuration menu (Camera Policy, Activity Tracker, etc.)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
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
        .setName('set-voice-minutes')
        .setDescription('Continuous minutes in voice required to count as activity (default 1)')
        .addIntegerOption((opt) => opt.setName('minutes').setDescription('Number of minutes').setRequired(true).setMinValue(1))
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-retention')
        .setDescription('Days before raw activity timestamps are permanently deleted (default 90)')
        .addIntegerOption((opt) => opt.setName('days').setDescription('Number of days').setRequired(true).setMinValue(1))
    )
    .addSubcommand((sub) => sub.setName('purge-now').setDescription('Manually run the data-retention cleanup right now'))
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
    .addSubcommand((sub) =>
      sub.setName('apply-restrictions').setDescription('Lock Inactive out of every channel except the quarantine channel (edits permissions server-wide)')
    )
    .addSubcommand((sub) => sub.setName('status').setDescription('View current activity tracker configuration'))
    .addSubcommand((sub) =>
      sub
        .setName('check')
        .setDescription("Manually check one member's activity status")
        .addUserOption((opt) => opt.setName('user').setDescription('Member to check').setRequired(true))
    ),
  new SlashCommandBuilder()
    .setName('category-perms')
    .setDescription('Bulk apply or remove role permission overwrites across categories')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('apply')
        .setDescription('Apply a saved template to one or more categories')
        .addStringOption((opt) => opt.setName('template').setDescription('Template name').setRequired(true))
        .addStringOption((opt) => opt.setName('categories').setDescription('Category IDs (comma-separated)').setRequired(true))
        .addBooleanOption((opt) => opt.setName('cascade').setDescription('Also apply to channels inside each category?').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('unsync')
        .setDescription('Remove all overwrites for specific roles from categories (and optionally their channels)')
        .addStringOption((opt) => opt.setName('roles').setDescription('Role IDs to strip (comma-separated)').setRequired(true))
        .addStringOption((opt) => opt.setName('categories').setDescription('Category IDs (comma-separated)').setRequired(true))
        .addBooleanOption((opt) => opt.setName('cascade').setDescription('Also strip from channels inside each category?').setRequired(true))
    )
    .addSubcommand((sub) => sub.setName('list-templates').setDescription('List saved permission templates for this server')),
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
// Keyed by guild ID, then by channel ID (not name) so two channels that
// happen to share a name in different categories — or across different
// servers running this bot — never collide. Each entry also stores the
// channel's current name so the file stays readable when you're editing it
// by hand — you can see at a glance which ID belongs to which channel.
const DESCRIPTIONS_FILE = dataPath('descriptions.json');

function ensureDescriptionsFile(guild) {
  const all = loadAllDescriptions();
  if (all[guild.id]) return; // never overwrite existing entries for this guild

  const data = getChannelData(guild);
  const template = {};
  for (const ch of data) {
    template[ch.id] = { name: ch.name, description: '' };
  }
  all[guild.id] = template;
  saveAllDescriptions(all);
  console.log(`Created descriptions for guild ${guild.id} in ${DESCRIPTIONS_FILE} — fill in the "description" fields whenever you're ready.`);
}

// Loads the whole file and migrates it once if it's still in the old flat
// (single-guild, not guild-keyed) format — wraps the existing entries under
// GUILD_ID so nothing already filled in gets lost.
function loadAllDescriptions() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(DESCRIPTIONS_FILE, 'utf-8'));
  } catch {
    return {};
  }
  const looksLegacyFlat = Object.values(raw).some((v) => v && typeof v === 'object' && 'name' in v && 'description' in v);
  if (looksLegacyFlat) {
    console.log('Migrating descriptions.json from the old flat format to per-guild format...');
    const migrated = { [GUILD_ID]: raw };
    saveAllDescriptions(migrated);
    return migrated;
  }
  return raw;
}

function saveAllDescriptions(all) {
  try {
    fs.writeFileSync(DESCRIPTIONS_FILE, JSON.stringify(all, null, 2));
    return true;
  } catch (err) {
    console.error(`Failed to save descriptions.json to ${DESCRIPTIONS_FILE}:`, err.message);
    return false;
  }
}

function loadDescriptions(guildId) {
  return loadAllDescriptions()[guildId] || {};
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

  // Activity tracker: reconcile who's currently connected to voice FIRST
  // (fixes the bug where a redeploy mid-call erases someone's voice
  // credit), then sync roles shortly after (let the member cache warm
  // up), then every 6 hours after that.
  setTimeout(reconcileConnectedVoiceMembers, 15 * 1000);
  setTimeout(syncAllActivityGuilds, 30 * 1000);
  setInterval(syncAllActivityGuilds, 6 * 60 * 60 * 1000);

  // Activity data retention: purge stale raw timestamps once a day. Runs a
  // couple minutes after the first role sync so pruning never races with
  // startup role assignment.
  setTimeout(pruneActivityData, 2 * 60 * 1000);
  setInterval(pruneActivityData, 24 * 60 * 60 * 1000);
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
      } else if (sub === 'set-voice-minutes') {
        const minutes = interaction.options.getInteger('minutes');
        guildConfig.voiceMinutesRequired = minutes;
        saveActivityConfig(activityConfig);
        await interaction.reply(`✅ Members now need **${minutes} continuous minute(s)** in voice to count as active.`);
      } else if (sub === 'set-retention') {
        const days = interaction.options.getInteger('days');
        if (days < guildConfig.thresholdDays) {
          await interaction.reply({
            content: `❌ Retention (${days} days) can't be shorter than your inactivity threshold (${guildConfig.thresholdDays} days) — that would delete activity records before they've even been used to decide Active/Inactive.`,
            ephemeral: true,
          });
        } else {
          guildConfig.retentionDays = days;
          saveActivityConfig(activityConfig);
          await interaction.reply(`✅ Activity records will now be automatically deleted after **${days} day(s)**.`);
        }
      } else if (sub === 'purge-now') {
        const pruned = pruneActivityData(interaction.guildId);
        await interaction.reply({
          content: pruned > 0 ? `✅ Purged **${pruned}** stale activity record(s) for this server.` : '✅ Nothing to purge — no records here are past the retention window.',
          ephemeral: true,
        });
      } else if (sub === 'set-quarantine-channel') {
        const channel = interaction.options.getChannel('channel');
        guildConfig.quarantineChannelId = channel.id;
        saveActivityConfig(activityConfig);
        await interaction.reply(
          `✅ Quarantine/reactivation channel set to **#${channel.name}**. Run \`/activity-tracker apply-restrictions\` to lock Inactive out of every other channel, then \`/activity-tracker post-button\`.`
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
      } else if (sub === 'apply-restrictions') {
        await interaction.deferReply({ ephemeral: true }); // this can take a few seconds on a large server
        const result = await applyInactiveChannelRestrictions(interaction.guild);
        if (!result.success) {
          await interaction.editReply(`❌ ${result.reason}`);
        } else {
          const failedNote = result.failed.length > 0 ? `\n⚠️ Failed on ${result.failed.length} channel(s) — check the bot has **Manage Roles** and can see those channels.` : '';
          await interaction.editReply(
            `🔒 Applied to **${result.updated}** channel(s). Inactive is now locked out everywhere except the quarantine channel, and any channel created from now on will be locked down automatically.${failedNote}`
          );
        }
      } else if (sub === 'status') {
        const storedRecordCount = Object.keys(activityData[interaction.guildId] || {}).length;
        const embed = new EmbedBuilder()
          .setColor(guildConfig.enabled ? 0x00cc66 : 0x999999)
          .setTitle('Activity Tracker Status')
          .addFields(
            { name: 'Enabled', value: guildConfig.enabled ? 'Yes' : 'No', inline: true },
            { name: 'Threshold', value: `${guildConfig.thresholdDays} days`, inline: true },
            { name: 'Voice minutes required', value: `${guildConfig.voiceMinutesRequired ?? DEFAULT_VOICE_MINUTES_REQUIRED} min`, inline: true },
            { name: 'Retention', value: `${guildConfig.retentionDays ?? DEFAULT_RETENTION_DAYS} days`, inline: true },
            { name: 'Active role', value: guildConfig.activeRoleId ? `<@&${guildConfig.activeRoleId}>` : 'Not set', inline: true },
            { name: 'Inactive role', value: guildConfig.inactiveRoleId ? `<@&${guildConfig.inactiveRoleId}>` : 'Not set', inline: true },
            {
              name: 'Quarantine channel',
              value: guildConfig.quarantineChannelId ? `<#${guildConfig.quarantineChannelId}>` : 'Not set',
              inline: true,
            },
            {
              name: 'Channel restrictions',
              value: guildConfig.channelRestrictionsApplied ? '🔒 Applied' : '🔓 Not applied',
              inline: true,
            },
            {
              name: 'Exempt roles',
              value: guildConfig.exemptRoleIds.length ? guildConfig.exemptRoleIds.map((id) => `<@&${id}>`).join(', ') : 'None',
            },
            {
              name: 'Records currently stored',
              value: `${storedRecordCount} member(s) — automatically deleted after ${guildConfig.retentionDays ?? DEFAULT_RETENTION_DAYS} day(s) of inactivity`,
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

    if (interaction.commandName === 'category-perms') {
      const sub = interaction.options.getSubcommand();
      const guildCfg = ensureCategoryPermsGuildConfig(interaction.guildId);

      if (sub === 'list-templates') {
        if (!guildCfg.templates.length) {
          return interaction.reply({ content: 'No templates saved yet. Create them from the dashboard at `/category-perms` page.', ephemeral: true });
        }
        const list = guildCfg.templates.map((t, i) => `**${i + 1}. ${t.name}** — ${t.rolePerms.length} role(s)`).join('\n');
        return interaction.reply({ content: `**Saved templates:**\n${list}`, ephemeral: true });
      }

      if (sub === 'apply') {
        const templateName = interaction.options.getString('template').trim();
        const template = guildCfg.templates.find((t) => t.name.toLowerCase() === templateName.toLowerCase());
        if (!template) {
          return interaction.reply({ content: `❌ No template named **${templateName}** found. Use \`/category-perms list-templates\` to see what's saved.`, ephemeral: true });
        }
        const categoryIds = interaction.options.getString('categories').split(',').map((s) => s.trim()).filter(Boolean);
        const cascade = interaction.options.getBoolean('cascade');
        await interaction.deferReply({ ephemeral: true });
        const result = await applyCategoryPermsTemplate(interaction.guild, template, categoryIds, cascade);
        const failNote = result.failed.length ? `\n⚠️ Failed on ${result.failed.length} item(s) — check bot has Manage Roles & Manage Channels.` : '';
        return interaction.editReply(`✅ Applied template **${template.name}** to ${categoryIds.length} categor${categoryIds.length === 1 ? 'y' : 'ies'} — **${result.updated}** overwrite(s) updated.${cascade ? ' (cascaded to child channels)' : ''}${failNote}`);
      }

      if (sub === 'unsync') {
        const roleIds = interaction.options.getString('roles').split(',').map((s) => s.trim()).filter(Boolean);
        const categoryIds = interaction.options.getString('categories').split(',').map((s) => s.trim()).filter(Boolean);
        const cascade = interaction.options.getBoolean('cascade');
        await interaction.deferReply({ ephemeral: true });
        const result = await unsyncCategoryPerms(interaction.guild, roleIds, categoryIds, cascade);
        const failNote = result.failed.length ? `\n⚠️ Failed on ${result.failed.length} item(s) — check bot has Manage Roles & Manage Channels.` : '';
        return interaction.editReply(`✅ Removed overwrites for ${roleIds.length} role(s) from ${categoryIds.length} categor${categoryIds.length === 1 ? 'y' : 'ies'} — **${result.updated}** overwrite(s) cleared.${cascade ? ' (cascaded to child channels)' : ''}${failNote}`);
      }
    }

    if (interaction.commandName === 'channel-index') {
      await interaction.deferReply();
      const categoryFilter = interaction.options.getString('category');
      const data = getChannelData(interaction.guild, categoryFilter);
      const indexCfg = ensureChannelIndexGuildConfig(interaction.guildId);

      // Group by category for a clean, readable post — skipping any
      // categories/channels/keywords excluded via the dashboard or /setup.
      const byCategory = {};
      for (const ch of data) {
        if (ch.categoryId && indexCfg.excludedCategoryIds.includes(ch.categoryId)) continue;
        if (indexCfg.excludedChannelIds.includes(ch.id)) continue;
        const nameLower = ch.name.toLowerCase();
        if (indexCfg.excludedNameKeywords.some((kw) => nameLower.includes(kw))) continue;

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

      const descriptions = loadDescriptions(interaction.guildId);

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

// ============================================================
// Web Dashboard — bundled into this same process, same as the Discord
// bot. Single shared password (DASHBOARD_PASSWORD, set as a Railway
// Variable) gates the whole thing — this is a personal admin tool, not a
// per-server-admin login system. Every page reads/writes the exact same
// config objects and functions the Discord side uses, so the dashboard
// and /setup are always in sync.
// ============================================================
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const PORT = process.env.PORT || 3000;

if (!DASHBOARD_PASSWORD) {
  console.warn('DASHBOARD_PASSWORD is not set — the dashboard will refuse all logins until you set it as a Railway Variable.');
}
if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET is not set — using a random secret generated at startup, so everyone gets logged out on every restart. Set SESSION_SECRET as a Railway Variable to avoid that.');
}

const app = express();
app.set('trust proxy', 1); // Railway sits behind a proxy — needed for secure cookies to work
app.use(express.urlencoded({ extended: true, limit: '3mb' })); // raised limit: the descriptions editor can post one field per channel

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: !!process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  })
);

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  return res.redirect('/login');
}

// Express gives a bare string for one checked box, an array for 2+, and
// undefined for zero — this normalizes all three to always be an array.
function asArray(val) {
  if (val === undefined) return [];
  return Array.isArray(val) ? val : [val];
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function resolveGuildId(req) {
  const requested = req.query.guild || req.body?.guild;
  if (requested && client.guilds.cache.has(requested)) return requested;
  if (client.guilds.cache.has(GUILD_ID)) return GUILD_ID;
  const first = client.guilds.cache.first();
  return first ? first.id : null;
}

// ---- Shared page shell: header nav + guild switcher + dark theme ----
function renderLayout({ title, guildId, currentPath, body, flash }) {
  const guilds = [...client.guilds.cache.values()];
  const guildOptions = guilds
    .map((g) => `<option value="${g.id}" ${g.id === guildId ? 'selected' : ''}>${escapeHtml(g.name)}</option>`)
    .join('');

  const navItems = [
    { path: '/', label: 'Overview' },
    { path: '/camera', label: 'Camera Policy' },
    { path: '/activity', label: 'Activity Tracker' },
    { path: '/channel-index', label: 'Channel Index' },
    { path: '/category-perms', label: 'Category Perms' },
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)} — G33KY Bot Dashboard</title>
<style>
  :root {
    --bg: #0d0d12; --panel: #17171f; --panel-border: #2a2a36;
    --accent: #b83df0; --accent-2: #ff2fb0;
    --text: #eaeaf2; --text-dim: #9a9aab;
    --green: #2ecc71; --red: #ff4d6d;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; min-height: 100vh; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { background: #0d0d14; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 14px 24px; background: linear-gradient(90deg, #1a0f24, #14141c); border-bottom: 1px solid var(--panel-border); flex-wrap: wrap; gap: 12px; }
  header h1 { font-size: 18px; margin: 0; background: linear-gradient(90deg, var(--accent), var(--accent-2)); -webkit-background-clip: text; background-clip: text; color: transparent; }
  nav { display: flex; gap: 4px; flex-wrap: wrap; }
  nav a { padding: 8px 14px; border-radius: 8px; color: var(--text-dim); font-size: 14px; font-weight: 500; }
  nav a:hover { color: var(--text); text-decoration: none; background: var(--panel); }
  nav a.active { color: #fff; background: var(--accent); }
  .topright { display: flex; align-items: center; gap: 10px; }
  select, input[type=text], input[type=number], input[type=password], textarea {
    background: #0d0d14; border: 1px solid var(--panel-border); color: var(--text);
    border-radius: 6px; padding: 8px 10px; font-size: 14px; font-family: inherit;
  }
  main { padding: 24px; max-width: 1000px; margin: 0 auto; }
  .card { background: var(--panel); border: 1px solid var(--panel-border); border-radius: 12px; padding: 20px; margin-bottom: 20px; }
  .card h2 { margin-top: 0; font-size: 16px; }
  .card h3 { font-size: 13px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 10px; }
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
  .stat { background: #0d0d14; border: 1px solid var(--panel-border); border-radius: 10px; padding: 14px; }
  .stat .num { font-size: 24px; font-weight: 700; }
  .stat .label { font-size: 12px; color: var(--text-dim); margin-top: 2px; }
  .pill { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .pill.on { background: rgba(46,204,113,0.15); color: var(--green); }
  .pill.off { background: rgba(255,77,109,0.15); color: var(--red); }
  form { margin: 0; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field label { font-size: 12px; color: var(--text-dim); }
  .checklist { max-height: 220px; overflow-y: auto; background: #0d0d14; border: 1px solid var(--panel-border); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 6px; }
  .check-item { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
  .check-item input { accent-color: var(--accent); }
  button, .btn { background: var(--accent); color: #fff; border: none; border-radius: 8px; padding: 9px 16px; font-size: 14px; font-weight: 600; cursor: pointer; }
  button:hover, .btn:hover { opacity: 0.9; }
  button.secondary { background: #2a2a36; }
  button.danger { background: var(--red); }
  .btn-row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
  .flash { background: rgba(184,61,240,0.15); border: 1px solid var(--accent); padding: 10px 14px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  table th, table td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--panel-border); }
  table input[type=text] { width: 100%; }
  .muted { color: var(--text-dim); font-size: 13px; }
</style>
</head>
<body>
<header>
  <h1>⚙️ G33KY Bot</h1>
  <nav>
    ${navItems.map((n) => `<a href="${n.path}?guild=${guildId || ''}" class="${n.path === currentPath ? 'active' : ''}">${n.label}</a>`).join('')}
  </nav>
  <div class="topright">
    <form method="GET" action="${currentPath}">
      <select name="guild" onchange="this.form.submit()">${guildOptions}</select>
    </form>
    <a href="/logout" class="btn secondary" style="padding:8px 14px;">Log out</a>
  </div>
</header>
<main>
  ${flash ? `<div class="flash">${escapeHtml(flash)}</div>` : ''}
  ${body}
</main>
</body>
</html>`;
}

// ---- Auth routes (unprotected) ----
app.get('/login', (req, res) => {
  if (req.session?.authenticated) return res.redirect('/');
  const error = req.query.error ? '<div class="flash" style="border-color:var(--red);">Incorrect password.</div>' : '';
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Log in — G33KY Bot Dashboard</title>
  <style>
    body { margin:0; background:#0d0d12; color:#eaeaf2; font-family:-apple-system,sans-serif; }
    .wrap { display:flex; align-items:center; justify-content:center; min-height:100vh; }
    .card { background:#17171f; border:1px solid #2a2a36; border-radius:14px; padding:32px; width:300px; text-align:center; }
    h1 { background: linear-gradient(90deg,#b83df0,#ff2fb0); -webkit-background-clip:text; background-clip:text; color:transparent; font-size:20px; }
    input { width:100%; margin:14px 0; padding:10px; border-radius:6px; border:1px solid #2a2a36; background:#0d0d14; color:#eaeaf2; box-sizing:border-box; }
    button { width:100%; padding:10px; border-radius:8px; border:none; background:#b83df0; color:#fff; font-weight:600; cursor:pointer; }
    .flash { background:rgba(255,77,109,0.15); border:1px solid #ff4d6d; padding:8px; border-radius:8px; font-size:13px; margin-bottom:10px; }
  </style></head><body>
  <div class="wrap"><div class="card">
    <h1>⚙️ G33KY Bot</h1>
    ${error}
    <form method="POST" action="/login">
      <input type="password" name="password" placeholder="Dashboard password" autofocus required>
      <button type="submit">Log in</button>
    </form>
  </div></div>
  </body></html>`);
});

app.post('/login', (req, res) => {
  if (!DASHBOARD_PASSWORD) {
    return res.status(503).send('Dashboard password is not configured. Set DASHBOARD_PASSWORD as a Railway Variable, then redeploy.');
  }
  const { password } = req.body;
  if (password && timingSafeStringEqual(password, DASHBOARD_PASSWORD)) {
    req.session.authenticated = true;
    return res.redirect('/');
  }
  return res.redirect('/login?error=1');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/health', (req, res) => res.status(200).send('ok')); // for Railway's healthcheck, unauthenticated on purpose

app.use(requireAuth); // everything below this line requires a logged-in session

// ---- Overview ----
app.get('/', async (req, res) => {
  const guildId = resolveGuildId(req);
  if (!guildId) {
    return res.send(
      renderLayout({
        title: 'Overview',
        guildId: null,
        currentPath: '/',
        body: `<div class="card"><p>No servers loaded yet — the bot may still be starting up. Refresh in a moment.</p></div>`,
      })
    );
  }

  const guild = client.guilds.cache.get(guildId);
  await guild.members.fetch().catch((err) => console.error(`[dashboard] Failed to fetch members for guild ${guild.id}:`, err.message)); // best-effort, for accurate Active/Inactive counts

  const camCfg = ensureGuildConfig(guildId);
  const actCfg = ensureActivityGuildConfig(guildId);
  const idxCfg = ensureChannelIndexGuildConfig(guildId);

  const inGraceOrWarning = [...warnedUsers.keys()].filter((k) => k.startsWith(`${guildId}:`)).length;
  const activeCount = actCfg.activeRoleId ? guild.roles.cache.get(actCfg.activeRoleId)?.members.size ?? 0 : 0;
  const inactiveCount = actCfg.inactiveRoleId ? guild.roles.cache.get(actCfg.inactiveRoleId)?.members.size ?? 0 : 0;
  const storedRecords = Object.keys(activityData[guildId] || {}).length;
  const totalChannels = guild.channels.cache.filter((c) => c.type !== ChannelType.GuildCategory).size;
  const descriptions = loadDescriptions(guildId);
  const descFilled = Object.values(descriptions).filter((d) => d.description && d.description.trim()).length;

  const body = `
    <div class="card">
      <h2>${escapeHtml(guild.name)}</h2>
      <div class="stat-grid">
        <div class="stat"><div class="num">${guild.memberCount}</div><div class="label">Members</div></div>
        <div class="stat"><div class="num">${totalChannels}</div><div class="label">Channels</div></div>
      </div>
    </div>

    <div class="card">
      <h3>📷 Camera Policy</h3>
      <p><span class="pill ${camCfg.enabled ? 'on' : 'off'}">${camCfg.enabled ? 'ENABLED' : 'DISABLED'}</span></p>
      <div class="stat-grid">
        <div class="stat"><div class="num">${camCfg.monitoredChannels.length}</div><div class="label">Monitored channels</div></div>
        <div class="stat"><div class="num">${camCfg.exemptRoles.length}</div><div class="label">Exempt roles</div></div>
        <div class="stat"><div class="num">${inGraceOrWarning}</div><div class="label">Currently in grace/warning</div></div>
      </div>
      <p style="margin-top:12px;"><a href="/camera?guild=${guildId}">Configure →</a></p>
    </div>

    <div class="card">
      <h3>📊 Activity Tracker</h3>
      <p><span class="pill ${actCfg.enabled ? 'on' : 'off'}">${actCfg.enabled ? 'ENABLED' : 'DISABLED'}</span></p>
      <div class="stat-grid">
        <div class="stat"><div class="num">${activeCount}</div><div class="label">Active members</div></div>
        <div class="stat"><div class="num">${inactiveCount}</div><div class="label">Inactive members</div></div>
        <div class="stat"><div class="num">${storedRecords}</div><div class="label">Stored activity records</div></div>
        <div class="stat"><div class="num">${actCfg.thresholdDays}d</div><div class="label">Threshold</div></div>
        <div class="stat"><div class="num">${actCfg.retentionDays ?? DEFAULT_RETENTION_DAYS}d</div><div class="label">Retention</div></div>
      </div>
      <p style="margin-top:12px;"><a href="/activity?guild=${guildId}">Configure →</a></p>
    </div>

    <div class="card">
      <h3># Channel Index</h3>
      <div class="stat-grid">
        <div class="stat"><div class="num">${idxCfg.excludedCategoryIds.length}</div><div class="label">Excluded categories</div></div>
        <div class="stat"><div class="num">${idxCfg.excludedChannelIds.length}</div><div class="label">Excluded channels</div></div>
        <div class="stat"><div class="num">${descFilled}/${totalChannels}</div><div class="label">Descriptions filled in</div></div>
      </div>
      <p style="margin-top:12px;"><a href="/channel-index?guild=${guildId}">Configure →</a></p>
    </div>

    <div class="card">
      <h3>🔐 Category Permissions</h3>
      <div class="stat-grid">
        <div class="stat"><div class="num">${ensureCategoryPermsGuildConfig(guildId).templates.length}</div><div class="label">Saved templates</div></div>
      </div>
      <p style="margin-top:12px;"><a href="/category-perms?guild=${guildId}">Configure →</a></p>
    </div>
  `;
  res.send(renderLayout({ title: 'Overview', guildId, currentPath: '/', body, flash: req.query.flash }));
});

// ---- Camera Policy ----
app.get('/camera', (req, res) => {
  const guildId = resolveGuildId(req);
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return res.redirect('/');
  const cfg = ensureGuildConfig(guildId);

  const voiceChannels = [...guild.channels.cache.filter((c) => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice).values()].sort((a, b) => a.rawPosition - b.rawPosition);
  const textChannels = [...guild.channels.cache.filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement).values()].sort((a, b) => a.rawPosition - b.rawPosition);
  const roles = [...guild.roles.cache.filter((r) => r.id !== guild.id).values()].sort((a, b) => b.position - a.position);

  const channelChecklist =
    voiceChannels.map((c) => `<label class="check-item"><input type="checkbox" name="monitoredChannels" value="${c.id}" ${cfg.monitoredChannels.includes(c.id) ? 'checked' : ''}> #${escapeHtml(c.name)}</label>`).join('') ||
    '<p class="muted">No voice channels found.</p>';
  const roleChecklist =
    roles.map((r) => `<label class="check-item"><input type="checkbox" name="exemptRoles" value="${r.id}" ${cfg.exemptRoles.includes(r.id) ? 'checked' : ''}> ${escapeHtml(r.name)}</label>`).join('') ||
    '<p class="muted">No roles found.</p>';
  const announceOptions = textChannels.map((c) => `<option value="${c.id}" ${cfg.announcementChannelId === c.id ? 'selected' : ''}>#${escapeHtml(c.name)}</option>`).join('');

  const body = `
    <div class="card">
      <h2>📷 Camera Policy — ${escapeHtml(guild.name)}</h2>
      <p><span class="pill ${cfg.enabled ? 'on' : 'off'}">${cfg.enabled ? 'ENABLED' : 'DISABLED'}</span>
      ${cfg.announcementUrl ? ` · <a href="${cfg.announcementUrl}" target="_blank" rel="noopener">View posted announcement ↗</a>` : ''}</p>
      <form method="POST" action="/camera/toggle">
        <input type="hidden" name="guild" value="${guildId}">
        <button class="${cfg.enabled ? 'danger' : ''}" type="submit">${cfg.enabled ? 'Disable' : 'Enable'}</button>
      </form>
    </div>

    <div class="card">
      <form method="POST" action="/camera/save">
        <input type="hidden" name="guild" value="${guildId}">
        <h3>Timing</h3>
        <div class="row">
          <div class="field"><label>Grace period (minutes)</label><input type="number" name="graceMinutes" min="0" value="${cfg.graceMinutes ?? DEFAULT_GRACE_MINUTES}"></div>
          <div class="field"><label>Warning period (minutes)</label><input type="number" name="warningMinutes" min="1" value="${cfg.warningMinutes ?? DEFAULT_WARNING_MINUTES}"></div>
        </div>
        <h3>Monitored voice channels</h3>
        <div class="checklist">${channelChecklist}</div>
        <h3 style="margin-top:16px;">Exempt roles</h3>
        <div class="checklist">${roleChecklist}</div>
        <div class="btn-row"><button type="submit">Save Changes</button></div>
      </form>
    </div>

    <div class="card">
      <h3>Exempt role</h3>
      <p class="muted">Creates a new Discord role and adds it to the exempt list above.</p>
      <form method="POST" action="/camera/create-exempt-role">
        <input type="hidden" name="guild" value="${guildId}">
        <button class="secondary" type="submit">Create Exempt Role</button>
      </form>
    </div>

    <div class="card">
      <h3>Post policy announcement</h3>
      <form method="POST" action="/camera/announce">
        <input type="hidden" name="guild" value="${guildId}">
        <div class="row">
          <div class="field" style="min-width:220px;">
            <label>Channel</label>
            <select name="channelId"><option value="">-- select a channel --</option>${announceOptions}</select>
          </div>
        </div>
        <div class="field">
          <label>Policy text</label>
          <textarea name="text" rows="5" style="width:100%;">Cameras must be ON while in monitored voice channels.

If your camera is off, you'll get a silent ${cfg.graceMinutes ?? DEFAULT_GRACE_MINUTES} minute grace period, then a reminder, then ${cfg.warningMinutes ?? DEFAULT_WARNING_MINUTES} more minute(s) before you're moved out of the channel. Turning your camera back on at any point cancels the timer.</textarea>
        </div>
        <div class="btn-row"><button type="submit">Post Announcement</button></div>
      </form>
    </div>
  `;
  res.send(renderLayout({ title: 'Camera Policy', guildId, currentPath: '/camera', body, flash: req.query.flash }));
});

app.post('/camera/toggle', (req, res) => {
  const guildId = req.body.guild;
  const cfg = ensureGuildConfig(guildId);
  cfg.enabled = !cfg.enabled;
  saveCameraConfig(cameraConfig);
  if (!cfg.enabled) clearAllCameraWarningsForGuild(guildId);
  res.redirect(`/camera?guild=${guildId}&flash=${encodeURIComponent(cfg.enabled ? 'Camera policy enabled.' : 'Camera policy disabled.')}`);
});

app.post('/camera/save', (req, res) => {
  const guildId = req.body.guild;
  const cfg = ensureGuildConfig(guildId);
  const grace = parseInt(req.body.graceMinutes, 10);
  const warning = parseInt(req.body.warningMinutes, 10);
  if (Number.isInteger(grace) && grace >= 0) cfg.graceMinutes = grace;
  if (Number.isInteger(warning) && warning >= 1) cfg.warningMinutes = warning;
  cfg.monitoredChannels = asArray(req.body.monitoredChannels);
  cfg.exemptRoles = asArray(req.body.exemptRoles);
  saveCameraConfig(cameraConfig);
  res.redirect(`/camera?guild=${guildId}&flash=${encodeURIComponent('Saved.')}`);
});

app.post('/camera/create-exempt-role', async (req, res) => {
  const guildId = req.body.guild;
  const guild = client.guilds.cache.get(guildId);
  const cfg = ensureGuildConfig(guildId);
  try {
    const role = await guild.roles.create({ name: 'Camera Policy Exempt', color: 0x3498db, reason: 'Created via dashboard' });
    cfg.exemptRoles.push(role.id);
    saveCameraConfig(cameraConfig);
    res.redirect(`/camera?guild=${guildId}&flash=${encodeURIComponent('Created role: ' + role.name)}`);
  } catch (err) {
    res.redirect(`/camera?guild=${guildId}&flash=${encodeURIComponent('Failed to create role — check the bot has Manage Roles. (' + err.message + ')')}`);
  }
});

app.post('/camera/announce', async (req, res) => {
  const guildId = req.body.guild;
  const guild = client.guilds.cache.get(guildId);
  const cfg = ensureGuildConfig(guildId);
  const { channelId, text } = req.body;
  if (!channelId || !text) {
    return res.redirect(`/camera?guild=${guildId}&flash=${encodeURIComponent('Pick a channel and enter text first.')}`);
  }
  try {
    const channel = await guild.channels.fetch(channelId);
    const embed = new EmbedBuilder().setColor(0x8a2be2).setTitle('📷 Camera Policy').setDescription(text).setTimestamp();
    const message = await channel.send({ embeds: [embed] });
    cfg.announcementChannelId = channelId;
    cfg.announcementUrl = `https://discord.com/channels/${guildId}/${channel.id}/${message.id}`;
    saveCameraConfig(cameraConfig);
    res.redirect(`/camera?guild=${guildId}&flash=${encodeURIComponent('Announcement posted.')}`);
  } catch (err) {
    res.redirect(`/camera?guild=${guildId}&flash=${encodeURIComponent('Failed to post — check the bot can send messages there. (' + err.message + ')')}`);
  }
});

// ---- Activity Tracker ----
app.get('/activity', (req, res) => {
  const guildId = resolveGuildId(req);
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return res.redirect('/');
  const cfg = ensureActivityGuildConfig(guildId);

  const roles = [...guild.roles.cache.filter((r) => r.id !== guild.id).values()].sort((a, b) => b.position - a.position);
  const textChannels = [...guild.channels.cache.filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement).values()].sort((a, b) => a.rawPosition - b.rawPosition);
  const voiceChannels = [...guild.channels.cache.filter((c) => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice).values()].sort((a, b) => a.rawPosition - b.rawPosition);
  const allTrackableChannels = [...textChannels, ...voiceChannels];

  const roleOptions = (selectedId) => roles.map((r) => `<option value="${r.id}" ${r.id === selectedId ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('');
  const exemptChecklist =
    roles.map((r) => `<label class="check-item"><input type="checkbox" name="exemptRoles" value="${r.id}" ${cfg.exemptRoleIds.includes(r.id) ? 'checked' : ''}> ${escapeHtml(r.name)}</label>`).join('') ||
    '<p class="muted">No roles found.</p>';
  const quarantineOptions = textChannels.map((c) => `<option value="${c.id}" ${cfg.quarantineChannelId === c.id ? 'selected' : ''}>#${escapeHtml(c.name)}</option>`).join('');
  const monitoredChecklist =
    allTrackableChannels.map((c) => `<label class="check-item"><input type="checkbox" name="monitoredChannels" value="${c.id}" ${cfg.monitoredChannels.includes(c.id) ? 'checked' : ''}> #${escapeHtml(c.name)}</label>`).join('') ||
    '<p class="muted">No channels found.</p>';
  const storedRecordCount = Object.keys(activityData[guildId] || {}).length;

  const body = `
    <div class="card">
      <h2>📊 Activity Tracker — ${escapeHtml(guild.name)}</h2>
      <p><span class="pill ${cfg.enabled ? 'on' : 'off'}">${cfg.enabled ? 'ENABLED' : 'DISABLED'}</span></p>
      <form method="POST" action="/activity/toggle">
        <input type="hidden" name="guild" value="${guildId}">
        <button class="${cfg.enabled ? 'danger' : ''}" type="submit">${cfg.enabled ? 'Disable' : 'Enable'}</button>
      </form>
    </div>

    <div class="card">
      <form method="POST" action="/activity/save-roles">
        <input type="hidden" name="guild" value="${guildId}">
        <h3>Roles</h3>
        <div class="row">
          <div class="field"><label>Active role</label><select name="activeRoleId"><option value="">-- none --</option>${roleOptions(cfg.activeRoleId)}</select></div>
          <div class="field"><label>Inactive role</label><select name="inactiveRoleId"><option value="">-- none --</option>${roleOptions(cfg.inactiveRoleId)}</select></div>
        </div>
        <h3>Exempt roles</h3>
        <div class="checklist">${exemptChecklist}</div>
        <div class="btn-row"><button type="submit">Save Roles</button></div>
      </form>
      <div class="btn-row">
        <form method="POST" action="/activity/create-role"><input type="hidden" name="guild" value="${guildId}"><input type="hidden" name="type" value="active"><button class="secondary" type="submit">Create Active Role</button></form>
        <form method="POST" action="/activity/create-role"><input type="hidden" name="guild" value="${guildId}"><input type="hidden" name="type" value="inactive"><button class="secondary" type="submit">Create Inactive Role</button></form>
        <form method="POST" action="/activity/create-role"><input type="hidden" name="guild" value="${guildId}"><input type="hidden" name="type" value="exempt"><button class="secondary" type="submit">Create Exempt Role</button></form>
      </div>
    </div>

    <div class="card">
      <form method="POST" action="/activity/save-channels">
        <input type="hidden" name="guild" value="${guildId}">
        <h3>Channels</h3>
        <div class="field"><label>Quarantine / reactivation channel</label><select name="quarantineChannelId"><option value="">-- none --</option>${quarantineOptions}</select></div>
        <h3 style="margin-top:16px;">Monitored channels (empty = track everywhere)</h3>
        <div class="checklist">${monitoredChecklist}</div>
        <div class="btn-row"><button type="submit">Save Channels</button></div>
      </form>
      <div class="btn-row">
        <form method="POST" action="/activity/create-channel"><input type="hidden" name="guild" value="${guildId}"><button class="secondary" type="submit">Create Reactivation Channel</button></form>
        <form method="POST" action="/activity/post-button"><input type="hidden" name="guild" value="${guildId}"><button class="secondary" type="submit">Post Reactivation Button</button></form>
      </div>
    </div>

    <div class="card">
      <h3>Channel restrictions</h3>
      <p><span class="pill ${cfg.channelRestrictionsApplied ? 'on' : 'off'}">${cfg.channelRestrictionsApplied ? '🔒 APPLIED' : '🔓 NOT APPLIED'}</span></p>
      <p class="muted">${
        cfg.channelRestrictionsApplied
          ? 'Inactive is locked out of every channel except the quarantine channel (View Channel, Send Messages, and Read Message History all denied elsewhere). New channels are locked down automatically from now on.'
          : 'Denies View Channel, Send Messages, and Read Message History for the Inactive role on every channel except the quarantine channel. This edits permissions across your whole server — requires the Inactive role and quarantine channel to be set above first.'
      }</p>
      <form method="POST" action="/activity/apply-restrictions" onsubmit="return confirm('This will edit permission overwrites on every channel in this server for the Inactive role. Continue?');">
        <input type="hidden" name="guild" value="${guildId}">
        <button class="danger" type="submit">🔒 ${cfg.channelRestrictionsApplied ? 'Re-apply' : 'Apply'} Channel Restrictions</button>
      </form>
    </div>

    <div class="card">
      <form method="POST" action="/activity/save-timing">
        <input type="hidden" name="guild" value="${guildId}">
        <h3>Threshold, voice minutes & retention</h3>
        <div class="row">
          <div class="field"><label>Inactivity threshold (days)</label><input type="number" name="thresholdDays" min="1" value="${cfg.thresholdDays}"></div>
          <div class="field"><label>Continuous voice minutes required</label><input type="number" name="voiceMinutesRequired" min="1" value="${cfg.voiceMinutesRequired ?? DEFAULT_VOICE_MINUTES_REQUIRED}"></div>
          <div class="field"><label>Data retention (days)</label><input type="number" name="retentionDays" min="1" value="${cfg.retentionDays ?? DEFAULT_RETENTION_DAYS}"></div>
        </div>
        <div class="btn-row"><button type="submit">Save</button></div>
      </form>
    </div>

    <div class="card">
      <h3>Data</h3>
      <p class="muted">${storedRecordCount} activity record(s) currently stored for this server.</p>
      <form method="POST" action="/activity/purge-now">
        <input type="hidden" name="guild" value="${guildId}">
        <button class="secondary" type="submit">Purge Stale Records Now</button>
      </form>
    </div>
  `;
  res.send(renderLayout({ title: 'Activity Tracker', guildId, currentPath: '/activity', body, flash: req.query.flash }));
});

app.post('/activity/toggle', (req, res) => {
  const guildId = req.body.guild;
  const cfg = ensureActivityGuildConfig(guildId);
  if (!cfg.enabled && (!cfg.activeRoleId || !cfg.inactiveRoleId)) {
    return res.redirect(`/activity?guild=${guildId}&flash=${encodeURIComponent('Set both Active and Inactive roles before enabling.')}`);
  }
  cfg.enabled = !cfg.enabled;
  saveActivityConfig(activityConfig);
  if (cfg.enabled) syncActivityRoles(client.guilds.cache.get(guildId));
  res.redirect(`/activity?guild=${guildId}&flash=${encodeURIComponent(cfg.enabled ? 'Activity tracking enabled.' : 'Activity tracking disabled.')}`);
});

app.post('/activity/save-roles', (req, res) => {
  const guildId = req.body.guild;
  const cfg = ensureActivityGuildConfig(guildId);
  cfg.activeRoleId = req.body.activeRoleId || null;
  cfg.inactiveRoleId = req.body.inactiveRoleId || null;
  cfg.exemptRoleIds = asArray(req.body.exemptRoles);
  saveActivityConfig(activityConfig);
  res.redirect(`/activity?guild=${guildId}&flash=${encodeURIComponent('Roles saved.')}`);
});

app.post('/activity/save-channels', (req, res) => {
  const guildId = req.body.guild;
  const cfg = ensureActivityGuildConfig(guildId);
  cfg.quarantineChannelId = req.body.quarantineChannelId || null;
  cfg.monitoredChannels = asArray(req.body.monitoredChannels);
  saveActivityConfig(activityConfig);
  res.redirect(`/activity?guild=${guildId}&flash=${encodeURIComponent('Channels saved.')}`);
});

app.post('/activity/save-timing', (req, res) => {
  const guildId = req.body.guild;
  const cfg = ensureActivityGuildConfig(guildId);
  const days = parseInt(req.body.thresholdDays, 10);
  const retention = parseInt(req.body.retentionDays, 10);
  const voiceMinutes = parseInt(req.body.voiceMinutesRequired, 10);
  if (!Number.isInteger(days) || days < 1) {
    return res.redirect(`/activity?guild=${guildId}&flash=${encodeURIComponent('Threshold must be 1+ days.')}`);
  }
  if (!Number.isInteger(retention) || retention < days) {
    return res.redirect(`/activity?guild=${guildId}&flash=${encodeURIComponent('Retention must be at least as long as the threshold.')}`);
  }
  if (!Number.isInteger(voiceMinutes) || voiceMinutes < 1) {
    return res.redirect(`/activity?guild=${guildId}&flash=${encodeURIComponent('Voice minutes must be 1 or more.')}`);
  }
  cfg.thresholdDays = days;
  cfg.retentionDays = retention;
  cfg.voiceMinutesRequired = voiceMinutes;
  saveActivityConfig(activityConfig);
  res.redirect(`/activity?guild=${guildId}&flash=${encodeURIComponent('Saved.')}`);
});

app.post('/activity/create-role', async (req, res) => {
  const guildId = req.body.guild;
  const guild = client.guilds.cache.get(guildId);
  const cfg = ensureActivityGuildConfig(guildId);
  const roleSpecs = {
    active: { name: 'Active Member', color: 0x00cc66 },
    inactive: { name: 'Inactive Member', color: 0x999999 },
    exempt: { name: 'Activity Tracker Exempt', color: 0x3498db },
  };
  const spec = roleSpecs[req.body.type];
  if (!spec) return res.redirect(`/activity?guild=${guildId}`);
  try {
    const role = await guild.roles.create({ name: spec.name, color: spec.color, reason: 'Created via dashboard' });
    if (req.body.type === 'active') cfg.activeRoleId = role.id;
    else if (req.body.type === 'inactive') cfg.inactiveRoleId = role.id;
    else cfg.exemptRoleIds.push(role.id);
    saveActivityConfig(activityConfig);
    res.redirect(`/activity?guild=${guildId}&flash=${encodeURIComponent('Created role: ' + role.name)}`);
  } catch (err) {
    res.redirect(`/activity?guild=${guildId}&flash=${encodeURIComponent('Failed to create role — check the bot has Manage Roles. (' + err.message + ')')}`);
  }
});

app.post('/activity/create-channel', async (req, res) => {
  const guildId = req.body.guild;
  const guild = client.guilds.cache.get(guildId);
  const cfg = ensureActivityGuildConfig(guildId);
  try {
    const permissionOverwrites = [];
    if (cfg.inactiveRoleId) permissionOverwrites.push({ id: cfg.inactiveRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
    const channel = await guild.channels.create({ name: 're-activate', type: ChannelType.GuildText, reason: 'Created via dashboard', permissionOverwrites });
    cfg.quarantineChannelId = channel.id;
    saveActivityConfig(activityConfig);
    res.redirect(`/activity?guild=${guildId}&flash=${encodeURIComponent('Created #' + channel.name)}`);
  } catch (err) {
    res.redirect(`/activity?guild=${guildId}&flash=${encodeURIComponent('Failed to create channel — check the bot has Manage Channels. (' + err.message + ')')}`);
  }
});

app.post('/activity/apply-restrictions', async (req, res) => {
  const guildId = req.body.guild;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return res.redirect('/');
  const result = await applyInactiveChannelRestrictions(guild);
  if (!result.success) {
    return res.redirect(`/activity?guild=${guildId}&flash=${encodeURIComponent(result.reason)}`);
  }
  const failedNote = result.failed.length > 0 ? ` (failed on ${result.failed.length} — check Manage Roles permission)` : '';
  res.redirect(`/activity?guild=${guildId}&flash=${encodeURIComponent(`Applied to ${result.updated} channel(s).${failedNote}`)}`);
});

app.post('/activity/post-button', async (req, res) => {
  const guildId = req.body.guild;
  const guild = client.guilds.cache.get(guildId);
  const cfg = ensureActivityGuildConfig(guildId);
  if (!cfg.quarantineChannelId) {
    return res.redirect(`/activity?guild=${guildId}&flash=${encodeURIComponent('Set a quarantine channel first.')}`);
  }
  try {
    const channel = await guild.channels.fetch(cfg.quarantineChannelId);
    const { embed, row } = buildReactivationEmbedAndRow();
    await channel.send({ embeds: [embed], components: [row] });
    res.redirect(`/activity?guild=${guildId}&flash=${encodeURIComponent('Button posted in #' + channel.name)}`);
  } catch (err) {
    res.redirect(`/activity?guild=${guildId}&flash=${encodeURIComponent('Failed to post — check the bot can send messages there. (' + err.message + ')')}`);
  }
});

app.post('/activity/purge-now', (req, res) => {
  const guildId = req.body.guild;
  const pruned = pruneActivityData(guildId);
  res.redirect(`/activity?guild=${guildId}&flash=${encodeURIComponent(pruned > 0 ? `Purged ${pruned} stale record(s).` : 'Nothing to purge.')}`);
});

// ---- Channel Index ----
app.get('/channel-index', (req, res) => {
  const guildId = resolveGuildId(req);
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return res.redirect('/');
  const cfg = ensureChannelIndexGuildConfig(guildId);

  const categories = [...guild.channels.cache.filter((c) => c.type === ChannelType.GuildCategory).values()].sort((a, b) => a.rawPosition - b.rawPosition);
  const allChannels = getChannelData(guild);

  const categoryChecklist =
    categories.map((c) => `<label class="check-item"><input type="checkbox" name="excludedCategoryIds" value="${c.id}" ${cfg.excludedCategoryIds.includes(c.id) ? 'checked' : ''}> ${escapeHtml(c.name)}</label>`).join('') ||
    '<p class="muted">No categories found.</p>';
  const channelChecklist =
    allChannels
      .map(
        (c) =>
          `<label class="check-item"><input type="checkbox" name="excludedChannelIds" value="${c.id}" ${cfg.excludedChannelIds.includes(c.id) ? 'checked' : ''}> #${escapeHtml(c.name)} ${
            c.category ? `<span class="muted">(${escapeHtml(c.category)})</span>` : ''
          }</label>`
      )
      .join('') || '<p class="muted">No channels found.</p>';

  const descriptions = loadDescriptions(guildId);
  const descRows = allChannels
    .map(
      (c) => `
    <tr>
      <td>#${escapeHtml(c.name)}</td>
      <td class="muted">${escapeHtml(c.category || '—')}</td>
      <td><input type="text" name="desc_${c.id}" value="${escapeHtml(descriptions[c.id]?.description || '')}" placeholder="Optional blurb..."></td>
    </tr>`
    )
    .join('');

  const body = `
    <div class="card">
      <h2># Channel Index — ${escapeHtml(guild.name)}</h2>
      <p class="muted">Controls what <code>/channel-index</code> leaves out when it posts. Doesn't affect the channels themselves.</p>
    </div>

    <div class="card">
      <form method="POST" action="/channel-index/save-exclusions">
        <input type="hidden" name="guild" value="${guildId}">
        <h3>Excluded categories</h3>
        <div class="checklist">${categoryChecklist}</div>
        <h3 style="margin-top:16px;">Excluded channels</h3>
        <div class="checklist">${channelChecklist}</div>
        <h3 style="margin-top:16px;">Excluded name keywords</h3>
        <div class="field"><label>One per line — any channel whose name contains one of these is skipped</label>
        <textarea name="excludedNameKeywords" rows="3" style="width:100%;">${escapeHtml(cfg.excludedNameKeywords.join('\n'))}</textarea></div>
        <div class="btn-row"><button type="submit">Save Exclusions</button></div>
      </form>
    </div>

    <div class="card">
      <h3>Channel descriptions</h3>
      <p class="muted">Shown next to each channel in the posted index.</p>
      <form method="POST" action="/channel-index/save-descriptions">
        <input type="hidden" name="guild" value="${guildId}">
        <table>
          <thead><tr><th>Channel</th><th>Category</th><th>Description</th></tr></thead>
          <tbody>${descRows}</tbody>
        </table>
        <div class="btn-row"><button type="submit">Save Descriptions</button></div>
      </form>
    </div>
  `;
  res.send(renderLayout({ title: 'Channel Index', guildId, currentPath: '/channel-index', body, flash: req.query.flash }));
});

app.post('/channel-index/save-exclusions', (req, res) => {
  const guildId = req.body.guild;
  const cfg = ensureChannelIndexGuildConfig(guildId);
  cfg.excludedCategoryIds = asArray(req.body.excludedCategoryIds);
  cfg.excludedChannelIds = asArray(req.body.excludedChannelIds);
  cfg.excludedNameKeywords = String(req.body.excludedNameKeywords || '')
    .split('\n')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  saveChannelIndexConfig(channelIndexConfig);
  res.redirect(`/channel-index?guild=${guildId}&flash=${encodeURIComponent('Exclusions saved.')}`);
});

app.post('/channel-index/save-descriptions', (req, res) => {
  const guildId = req.body.guild;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return res.redirect('/');
  const allChannels = getChannelData(guild);
  const all = loadAllDescriptions();
  const guildDescriptions = all[guildId] || {};
  for (const c of allChannels) {
    const value = req.body[`desc_${c.id}`];
    guildDescriptions[c.id] = { name: c.name, description: (value || '').trim() };
  }
  all[guildId] = guildDescriptions;
  saveAllDescriptions(all);
  res.redirect(`/channel-index?guild=${guildId}&flash=${encodeURIComponent('Descriptions saved.')}`);
});

// ---- Category Permissions Dashboard ----
app.get('/category-perms', (req, res) => {
  const guildId = resolveGuildId(req);
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return res.redirect('/');
  const cfg = ensureCategoryPermsGuildConfig(guildId);

  const categories = [...guild.channels.cache.filter((c) => c.type === ChannelType.GuildCategory).values()].sort((a, b) => a.rawPosition - b.rawPosition);
  const roles = [...guild.roles.cache.filter((r) => r.id !== guild.id).values()].sort((a, b) => b.position - a.position);

  const categoryCheckboxes = categories
    .map((c) => `<label class="check-item"><input type="checkbox" class="cat-check" name="categoryIds" value="${c.id}"> ${escapeHtml(c.name)}</label>`)
    .join('') || '<p class="muted">No categories found.</p>';

  const unsyncCategoryCheckboxes = categories
    .map((c) => `<label class="check-item"><input type="checkbox" name="categoryIds" value="${c.id}"> ${escapeHtml(c.name)}</label>`)
    .join('') || '<p class="muted">No categories found.</p>';

  const roleOptions = roles.map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');
  const unsyncRoleCheckboxes = roles
    .map((r) => `<label class="check-item"><input type="checkbox" name="roleIds" value="${r.id}"> ${escapeHtml(r.name)}</label>`)
    .join('') || '<p class="muted">No roles found.</p>';

  // Build the permission rows for the template builder, grouped by section
  const permRows = (() => {
    const groups = [...new Set(MANAGED_PERMS.map((p) => p.group))];
    return groups.map((g) => {
      const groupPerms = MANAGED_PERMS.filter((p) => p.group === g);
      const header = `<tr><td colspan="2" style="padding-top:12px;padding-bottom:4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-dim);border-bottom:1px solid var(--panel-border);">${escapeHtml(g)}</td></tr>`;
      const rows = groupPerms.map((p) => `
        <tr>
          <td style="font-size:13px;padding-left:8px;">${escapeHtml(p.label)}</td>
          <td><select name="perm_${p.key}" style="width:100%;">
            <option value="neutral">— Inherit —</option>
            <option value="allow">✅ Allow</option>
            <option value="deny">❌ Deny</option>
          </select></td>
        </tr>`).join('');
      return header + rows;
    }).join('');
  })();

  // Build the saved templates list
  const templatesList = cfg.templates.length
    ? cfg.templates.map((t, i) => `
      <div class="card" style="margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;">
          <div>
            <strong>${escapeHtml(t.name)}</strong>
            <span class="muted" style="margin-left:8px;">${t.rolePerms.length} role(s) configured</span>
            <div style="margin-top:6px;font-size:12px;color:var(--text-dim);">
              ${t.rolePerms.map((rp) => {
                const role = guild.roles.cache.get(rp.roleId);
                const permsStr = Object.entries(rp.perms)
                  .filter(([, v]) => v !== 'neutral')
                  .map(([k, v]) => `${v === 'allow' ? '✅' : '❌'} ${MANAGED_PERMS.find((p) => p.key === k)?.label || k}`)
                  .join(', ') || 'all inherit';
                return `<div><strong>${escapeHtml(role?.name || rp.roleId)}:</strong> ${escapeHtml(permsStr)}</div>`;
              }).join('')}
            </div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <form method="POST" action="/category-perms/delete-template" style="margin:0;">
              <input type="hidden" name="guild" value="${guildId}">
              <input type="hidden" name="templateIndex" value="${i}">
              <button class="danger" type="submit" style="padding:6px 12px;font-size:12px;" onclick="return confirm('Delete template ${escapeHtml(t.name)}?')">Delete</button>
            </form>
          </div>
        </div>
        <hr style="border-color:var(--panel-border);margin:12px 0;">
        <form method="POST" action="/category-perms/apply">
          <input type="hidden" name="guild" value="${guildId}">
          <input type="hidden" name="templateIndex" value="${i}">
          <div class="row" style="align-items:flex-end;gap:12px;">
            <div class="field"><label>Apply to categories</label>
              <div class="checklist" style="max-height:150px;">${categories.map((c) => `<label class="check-item"><input type="checkbox" name="categoryIds" value="${c.id}"> ${escapeHtml(c.name)}</label>`).join('')}</div>
            </div>
            <div class="field"><label>Cascade to child channels?</label>
              <select name="cascade">
                <option value="yes">Yes — categories + all channels inside</option>
                <option value="no">No — categories only</option>
              </select>
            </div>
          </div>
          <div class="btn-row"><button type="submit">🚀 Apply This Template</button></div>
        </form>
      </div>`).join('')
    : '<p class="muted">No templates saved yet — create one below.</p>';

  const body = `
    <div class="card">
      <h2>🔐 Category Permissions — ${escapeHtml(guild.name)}</h2>
      <p class="muted">Build reusable permission templates, then bulk-apply them to categories (and optionally their channels) in one action. Great for keeping bot access, staff roles, and verified member perms uniform across all categories.</p>
    </div>

    <div class="card">
      <h3>Saved Templates</h3>
      ${templatesList}
    </div>

    <div class="card">
      <h3>Create New Template</h3>
      <form method="POST" action="/category-perms/save-template">
        <input type="hidden" name="guild" value="${guildId}">
        <div class="field" style="margin-bottom:14px;">
          <label>Template name</label>
          <input type="text" name="templateName" placeholder="e.g. Staff Roles, Verified Members, Bots" style="max-width:400px;" required>
        </div>
        <p class="muted" style="margin-bottom:10px;">Add roles one at a time — save the template first with one role, then edit to add more (or add them all now by submitting once per role).</p>
        <div class="field" style="margin-bottom:14px;">
          <label>Role</label>
          <select name="roleId" style="max-width:400px;">
            <option value="">-- select a role --</option>
            ${roleOptions}
          </select>
        </div>
        <h3 style="margin-top:8px;">Permissions for this role</h3>
        <table style="max-width:500px;">
          <thead><tr><th>Permission</th><th>Value</th></tr></thead>
          <tbody>${permRows}</tbody>
        </table>
        <div class="btn-row"><button type="submit">💾 Save Template</button></div>
      </form>
    </div>

    <div class="card">
      <h3>Add Role to Existing Template</h3>
      <form method="POST" action="/category-perms/add-role-to-template">
        <input type="hidden" name="guild" value="${guildId}">
        <div class="row">
          <div class="field">
            <label>Template</label>
            <select name="templateIndex" style="max-width:300px;">
              ${cfg.templates.map((t, i) => `<option value="${i}">${escapeHtml(t.name)}</option>`).join('') || '<option value="">No templates yet</option>'}
            </select>
          </div>
          <div class="field">
            <label>Role</label>
            <select name="roleId" style="max-width:300px;">
              <option value="">-- select a role --</option>
              ${roleOptions}
            </select>
          </div>
        </div>
        <h3 style="margin-top:8px;">Permissions for this role</h3>
        <table style="max-width:500px;">
          <thead><tr><th>Permission</th><th>Value</th></tr></thead>
          <tbody>${(() => {
            const groups = [...new Set(MANAGED_PERMS.map((p) => p.group))];
            return groups.map((g) => {
              const groupPerms = MANAGED_PERMS.filter((p) => p.group === g);
              const header = `<tr><td colspan="2" style="padding-top:12px;padding-bottom:4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-dim);border-bottom:1px solid var(--panel-border);">${escapeHtml(g)}</td></tr>`;
              const rows = groupPerms.map((p) => `
                <tr>
                  <td style="font-size:13px;padding-left:8px;">${escapeHtml(p.label)}</td>
                  <td><select name="perm_${p.key}" style="width:100%;">
                    <option value="neutral">— Inherit —</option>
                    <option value="allow">✅ Allow</option>
                    <option value="deny">❌ Deny</option>
                  </select></td>
                </tr>`).join('');
              return header + rows;
            }).join('');
          })()}</tbody>
        </table>
        <div class="btn-row"><button type="submit">➕ Add Role to Template</button></div>
      </form>
    </div>

    <div class="card">
      <h3>🔓 Unsync — Remove Role Overwrites</h3>
      <p class="muted">Strips ALL permission overwrites for the selected roles from the selected categories (and optionally their child channels). This resets those roles to inherit permissions from the server default.</p>
      <form method="POST" action="/category-perms/unsync" onsubmit="return confirm('This will delete all selected role overwrites from the selected categories/channels. Continue?');">
        <input type="hidden" name="guild" value="${guildId}">
        <div class="row">
          <div class="field">
            <label>Roles to strip</label>
            <div class="checklist">${unsyncRoleCheckboxes}</div>
          </div>
          <div class="field">
            <label>From categories</label>
            <div class="checklist">${unsyncCategoryCheckboxes}</div>
          </div>
          <div class="field">
            <label>Cascade?</label>
            <select name="cascade">
              <option value="yes">Yes — categories + all channels inside</option>
              <option value="no">No — categories only</option>
            </select>
          </div>
        </div>
        <div class="btn-row"><button class="danger" type="submit">🔓 Unsync / Remove Overwrites</button></div>
      </form>
    </div>
  `;
  res.send(renderLayout({ title: 'Category Permissions', guildId, currentPath: '/category-perms', body, flash: req.query.flash }));
});

app.post('/category-perms/save-template', (req, res) => {
  const guildId = req.body.guild;
  const cfg = ensureCategoryPermsGuildConfig(guildId);
  const templateName = String(req.body.templateName || '').trim();
  const roleId = req.body.roleId;
  if (!templateName || !roleId) {
    return res.redirect(`/category-perms?guild=${guildId}&flash=${encodeURIComponent('Give the template a name and pick a role.')}`);
  }
  const perms = {};
  for (const p of MANAGED_PERMS) {
    perms[p.key] = req.body[`perm_${p.key}`] || 'neutral';
  }
  // If a template with this name already exists, add the role to it
  const existing = cfg.templates.find((t) => t.name.toLowerCase() === templateName.toLowerCase());
  if (existing) {
    const existingRole = existing.rolePerms.find((rp) => rp.roleId === roleId);
    if (existingRole) {
      existingRole.perms = perms;
    } else {
      existing.rolePerms.push({ roleId, perms });
    }
  } else {
    cfg.templates.push({ name: templateName, rolePerms: [{ roleId, perms }] });
  }
  saveCategoryPermsConfig(categoryPermsConfig);
  res.redirect(`/category-perms?guild=${guildId}&flash=${encodeURIComponent(`Template "${templateName}" saved.`)}`);
});

app.post('/category-perms/add-role-to-template', (req, res) => {
  const guildId = req.body.guild;
  const cfg = ensureCategoryPermsGuildConfig(guildId);
  const idx = parseInt(req.body.templateIndex, 10);
  const roleId = req.body.roleId;
  if (isNaN(idx) || !cfg.templates[idx] || !roleId) {
    return res.redirect(`/category-perms?guild=${guildId}&flash=${encodeURIComponent('Pick a template and a role.')}`);
  }
  const perms = {};
  for (const p of MANAGED_PERMS) {
    perms[p.key] = req.body[`perm_${p.key}`] || 'neutral';
  }
  const template = cfg.templates[idx];
  const existingRole = template.rolePerms.find((rp) => rp.roleId === roleId);
  if (existingRole) {
    existingRole.perms = perms;
  } else {
    template.rolePerms.push({ roleId, perms });
  }
  saveCategoryPermsConfig(categoryPermsConfig);
  res.redirect(`/category-perms?guild=${guildId}&flash=${encodeURIComponent(`Role added/updated in template "${template.name}".`)}`);
});

app.post('/category-perms/delete-template', (req, res) => {
  const guildId = req.body.guild;
  const cfg = ensureCategoryPermsGuildConfig(guildId);
  const idx = parseInt(req.body.templateIndex, 10);
  if (isNaN(idx) || !cfg.templates[idx]) {
    return res.redirect(`/category-perms?guild=${guildId}&flash=${encodeURIComponent('Template not found.')}`);
  }
  const name = cfg.templates[idx].name;
  cfg.templates.splice(idx, 1);
  saveCategoryPermsConfig(categoryPermsConfig);
  res.redirect(`/category-perms?guild=${guildId}&flash=${encodeURIComponent(`Deleted template "${name}".`)}`);
});

app.post('/category-perms/apply', async (req, res) => {
  const guildId = req.body.guild;
  const guild = client.guilds.cache.get(guildId);
  const cfg = ensureCategoryPermsGuildConfig(guildId);
  const idx = parseInt(req.body.templateIndex, 10);
  if (isNaN(idx) || !cfg.templates[idx]) {
    return res.redirect(`/category-perms?guild=${guildId}&flash=${encodeURIComponent('Template not found.')}`);
  }
  const categoryIds = asArray(req.body.categoryIds);
  if (!categoryIds.length) {
    return res.redirect(`/category-perms?guild=${guildId}&flash=${encodeURIComponent('Pick at least one category to apply to.')}`);
  }
  const cascade = req.body.cascade === 'yes';
  const template = cfg.templates[idx];
  const result = await applyCategoryPermsTemplate(guild, template, categoryIds, cascade);
  const failNote = result.failed.length ? ` (failed on ${result.failed.length} — check bot has Manage Roles & Manage Channels)` : '';
  res.redirect(`/category-perms?guild=${guildId}&flash=${encodeURIComponent(`Applied "${template.name}" to ${categoryIds.length} categor${categoryIds.length === 1 ? 'y' : 'ies'} — ${result.updated} overwrite(s) updated.${cascade ? ' Cascaded to child channels.' : ''}${failNote}`)}`);
});

app.post('/category-perms/unsync', async (req, res) => {
  const guildId = req.body.guild;
  const guild = client.guilds.cache.get(guildId);
  const roleIds = asArray(req.body.roleIds);
  const categoryIds = asArray(req.body.categoryIds);
  if (!roleIds.length || !categoryIds.length) {
    return res.redirect(`/category-perms?guild=${guildId}&flash=${encodeURIComponent('Pick at least one role and one category.')}`);
  }
  const cascade = req.body.cascade === 'yes';
  const result = await unsyncCategoryPerms(guild, roleIds, categoryIds, cascade);
  const failNote = result.failed.length ? ` (failed on ${result.failed.length} — check bot has Manage Roles & Manage Channels)` : '';
  res.redirect(`/category-perms?guild=${guildId}&flash=${encodeURIComponent(`Removed overwrites for ${roleIds.length} role(s) from ${categoryIds.length} categor${categoryIds.length === 1 ? 'y' : 'ies'} — ${result.updated} cleared.${cascade ? ' Cascaded to child channels.' : ''}${failNote}`)}`);
});

app.listen(PORT, () => {
  console.log(`Dashboard listening on port ${PORT}`);
});

client.login(TOKEN);
