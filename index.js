// G33KY BOT — Discord community management bot
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
  MessageFlags,
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
      monitoredCategoryIds: [],  // NEW: all voice channels inside these categories are monitored
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
  // Normalize configs saved before monitoredCategoryIds existed
  if (cameraConfig[guildId].monitoredCategoryIds === undefined) {
    cameraConfig[guildId].monitoredCategoryIds = [];
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

// Resolves the full set of monitored channel IDs — explicit channels PLUS
// any voice/stage channels that live inside a monitored category.
// guild can be null (falls back to explicit channels only).
function getEffectiveMonitoredChannelIds(guildId, guild) {
  const cfg = ensureGuildConfig(guildId);
  const ids = new Set(cfg.monitoredChannels);
  if (guild && cfg.monitoredCategoryIds?.length) {
    for (const ch of guild.channels.cache.values()) {
      if (
        ch.parentId &&
        cfg.monitoredCategoryIds.includes(ch.parentId) &&
        (ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice)
      ) {
        ids.add(ch.id);
      }
    }
  }
  return ids;
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

// ---- First-run defaults (universal) ----
// When a guild uses the bot for the first time, start with safe empty defaults.
// Admins configure everything via slash commands or the dashboard — nothing is
// hardcoded to any specific server.

function seedCameraConfigIfNeeded() {
  // Nothing to seed universally — each guild gets a clean config the first time
  // ensureGuildConfig() is called for it, which already handles defaults.
  // This function is kept for compatibility but is intentionally a no-op.
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
let activityData = loadActivityData();

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
      verifiedRoleId: null,       // only assign Active if member has this role
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
  if (activityConfig[guildId].verifiedRoleId === undefined) {
    activityConfig[guildId].verifiedRoleId = null;
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

client.on('voiceStateUpdate', async (oldState, newState) => {
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

  // Speed dating: assign participant role when someone joins a lobby during an active session
  if (nowInChannel && newState.member && !newState.member.user.bot) {
    const shuffleCfg = vcShuffleConfig[guildId];
    if (shuffleCfg?.enabled && shuffleCfg.participantRoleId && shuffleCfg.lobbyChannelIds?.includes(newState.channelId)) {
      try {
        if (!newState.member.roles.cache.has(shuffleCfg.participantRoleId)) {
          await newState.member.roles.add(shuffleCfg.participantRoleId, '💨 High-Speed Connection: joined lobby');
        }
      } catch (err) {
        console.error(`[vc-shuffle] Could not auto-assign participant role to ${userId}:`, err.message);
      }
    }
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

    // Only track members who have the verified role (if one is configured).
    // Members without it are completely ignored — they're unverified.
    const hasVerified = config.verifiedRoleId ? member.roles.cache.has(config.verifiedRoleId) : true;
    const hasInactive = config.inactiveRoleId ? member.roles.cache.has(config.inactiveRoleId) : false;

    // Skip entirely if they have neither verified nor inactive role — not our concern
    if (!hasVerified && !hasInactive) continue;

    const activity = activityData[guild.id]?.[member.id];
    const lastMessageAt = activity?.lastMessageAt || 0;
    const lastVoiceActiveAt = activity?.lastVoiceActiveAt || 0;
    const joinedAt = member.joinedTimestamp || 0;
    const lastActive = Math.max(lastMessageAt, lastVoiceActiveAt, joinedAt);
    const isActive = now - lastActive <= thresholdMs;

    try {
      if (isActive) {
        // Active — ensure they have verified role, no inactive role
        if (config.inactiveRoleId && hasInactive) await member.roles.remove(config.inactiveRoleId);
        if (config.verifiedRoleId && !hasVerified) {
          await member.roles.add(config.verifiedRoleId);
          madeActive++;
        }
        if (config.activeRoleId && !member.roles.cache.has(config.activeRoleId)) {
          await member.roles.add(config.activeRoleId);
        }
      } else {
        // Inactive — remove verified role, add inactive role
        if (!hasInactive) {
          if (config.verifiedRoleId && hasVerified) await member.roles.remove(config.verifiedRoleId);
          if (config.activeRoleId && member.roles.cache.has(config.activeRoleId)) await member.roles.remove(config.activeRoleId);
          if (config.inactiveRoleId) {
            await member.roles.add(config.inactiveRoleId);
            madeInactive++;
          }
        }
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
// Sets the Inactive role's permission overwrite on ONLY the quarantine/reactivation
// channel — allowing them to see it and click the reactivate button.
// Everything else stays invisible because @everyone has no View Channel server-wide.
// This only needs to run once when the channel is first configured, or if the
// inactive role changes.
async function applyInactiveChannelRestrictions(guild) {
  const cfg = ensureActivityGuildConfig(guild.id);
  if (!cfg.inactiveRoleId || !cfg.quarantineChannelId) {
    return { success: false, reason: 'Set both the Inactive role and the reactivation channel first.' };
  }

  const channel = guild.channels.cache.get(cfg.quarantineChannelId);
  if (!channel) {
    return { success: false, reason: 'Reactivation channel not found — has it been deleted?' };
  }

  try {
    // Allow inactive members to see and interact with ONLY this channel
    await channel.permissionOverwrites.edit(cfg.inactiveRoleId, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false, // read-only — they can only click the reactivate button
    });

    cfg.channelRestrictionsApplied = true;
    saveActivityConfig(activityConfig);

    return { success: true, updated: 1, failed: [] };
  } catch (err) {
    console.error(`[activity-restrictions] Failed to set inactive channel perms in ${guild.id}:`, err.message);
    return { success: false, reason: err.message };
  }
}

// No channelCreate listener needed — new channels stay invisible to Inactive
// members automatically because @everyone has no View Channel server-wide.
// Only the reactivation channel has an explicit Inactive role overwrite.

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

  // Stamp activity as now — gives them a fresh 30 days
  const activity = getMemberActivity(interaction.guild.id, interaction.user.id);
  activity.lastMessageAt = Date.now();
  saveActivityData(activityData);

  const member = interaction.member;
  try {
    // Remove inactive role
    if (config.inactiveRoleId && member.roles.cache.has(config.inactiveRoleId)) {
      await member.roles.remove(config.inactiveRoleId);
    }
    // Restore verified role
    if (config.verifiedRoleId && !member.roles.cache.has(config.verifiedRoleId)) {
      await member.roles.add(config.verifiedRoleId);
    }
    // Add active role
    if (config.activeRoleId && !member.roles.cache.has(config.activeRoleId)) {
      await member.roles.add(config.activeRoleId);
    }
    await interaction.reply({ content: "Welcome back!! You've been reactivated — full access restored. You'll stay active as long as you send a message or spend time in voice at least once every 30 days. 🖤", flags: MessageFlags.Ephemeral });
  } catch (err) {
    console.error('Reactivation failed:', err);
    await interaction.reply({ content: 'Something went wrong reactivating you — ping a mod for help.', flags: MessageFlags.Ephemeral });
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

  const catCount = cfg.monitoredCategoryIds?.length ?? 0;
  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle('📷 Camera Policy Configuration')
    .setDescription(
      `**Status:** ${cfg.enabled ? '🟢 Enabled' : '🔴 Disabled'}\n` +
        `**Timing:** ${cfg.graceMinutes ?? DEFAULT_GRACE_MINUTES}m grace + ${cfg.warningMinutes ?? DEFAULT_WARNING_MINUTES}m warning\n` +
        `**Announcement:** ${cfg.announcementUrl ? `[view post](${cfg.announcementUrl})` : 'Not posted yet'}\n` +
        `**Monitored Channels:** ${cfg.monitoredChannels.length ? cfg.monitoredChannels.map((id) => `<#${id}>`).join(', ') : 'Not set'}\n` +
        `**Monitored Categories:** ${catCount ? cfg.monitoredCategoryIds.map((id) => `<#${id}>`).join(', ') : 'Not set'} ${catCount ? `*(all voice channels inside are monitored)*` : ''}\n` +
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
    new ButtonBuilder().setCustomId('setup:camera:categories-menu').setLabel('🗂 Monitored Categories').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:main').setLabel('⬅ Back').setStyle(ButtonStyle.Secondary)
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

// Camera categories sub-page (separate message to avoid the 5-row cap)
function buildCameraCategoriesMenuMessage(guildId) {
  const cfg = ensureGuildConfig(guildId);
  const catCount = cfg.monitoredCategoryIds?.length ?? 0;

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle('📷 Camera Policy — Monitored Categories')
    .setDescription(
      `Select one or more **categories** below. Every voice channel inside a selected category will be treated as a monitored channel — you don't need to add them individually.\n\n` +
      `**Currently monitored categories:** ${catCount ? cfg.monitoredCategoryIds.map((id) => `<#${id}>`).join(', ') : 'None'}\n\n` +
      `*This stacks with per-channel selections on the main page — both lists are checked.*`
    );

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:camera:menu').setLabel('⬅ Back to Camera Policy').setStyle(ButtonStyle.Secondary)
  );

  const categorySelect = new ChannelSelectMenuBuilder()
    .setCustomId('setup:camera:categories:select')
    .setPlaceholder('Select monitored categories...')
    .setChannelTypes(ChannelType.GuildCategory)
    .setMinValues(0)
    .setMaxValues(25);
  if (catCount) categorySelect.setDefaultChannels(...cfg.monitoredCategoryIds.slice(0, 25));

  return {
    embeds: [embed],
    components: [
      backRow,
      new ActionRowBuilder().addComponents(categorySelect),
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
      return interaction.reply({ ...buildMainMenuMessage(), flags: MessageFlags.Ephemeral });
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
      return;
    }
    if (id === 'setup:camera:menu') return interaction.update(buildCameraMenuMessage(guildId));
    if (id === 'setup:camera:categories-menu') return interaction.update(buildCameraCategoriesMenuMessage(guildId));
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
          flags: MessageFlags.Ephemeral,
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

    if (id === 'setup:camera:categories:select') {
      const cfg = ensureGuildConfig(guildId);
      cfg.monitoredCategoryIds = interaction.values;
      saveCameraConfig(cameraConfig);
      return interaction.update(buildCameraCategoriesMenuMessage(guildId));
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
        return interaction.reply({ content: '❌ Grace must be 0+ and warning must be 1+ (whole numbers, in minutes).', flags: MessageFlags.Ephemeral });
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
          colors: [0x3498db],
          reason: 'Created via /setup — camera policy',
        });
        cfg.exemptRoles.push(role.id);
        saveCameraConfig(cameraConfig);
        await interaction.update(buildCameraMenuMessage(guildId));
      } catch (err) {
        console.error('Failed to create camera exempt role:', err.message);
        await interaction.reply({
          content: `❌ Couldn't create that role — make sure I have the **Manage Roles** permission. (${err.message})`,
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    if (id === 'setup:camera:announce-post') {
      const cfg = ensureGuildConfig(guildId);
      if (!cfg.announcementChannelId) {
        return interaction.reply({ content: '❌ Pick an announcement channel below first.', flags: MessageFlags.Ephemeral });
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
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    // ---- Activity tracker: main page ----
    if (id === 'setup:activity:toggle') {
      const cfg = ensureActivityGuildConfig(guildId);
      if (!cfg.enabled && (!cfg.activeRoleId || !cfg.inactiveRoleId)) {
        return interaction.reply({ content: '❌ Pick both an Active role and an Inactive role in the Roles page before turning this on.', flags: MessageFlags.Ephemeral });
      }
      cfg.enabled = !cfg.enabled;
      const saved = saveActivityConfig(activityConfig);
      if (cfg.enabled) syncActivityRoles(interaction.guild);
      await interaction.update(buildActivityMenuMessage(guildId));
      if (!saved) {
        await interaction.followUp({
          content: "⚠️ This didn't save to disk — it'll revert if the bot restarts. Check Railway logs for a DATA_DIR write error.",
          flags: MessageFlags.Ephemeral,
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
        return interaction.reply({ content: '❌ Threshold must be a whole number of days, 1 or more.', flags: MessageFlags.Ephemeral });
      }
      if (!Number.isInteger(retention) || retention < 1) {
        return interaction.reply({ content: '❌ Retention must be a whole number of days, 1 or more.', flags: MessageFlags.Ephemeral });
      }
      if (retention < days) {
        return interaction.reply({
          content: `❌ Retention (${retention} days) can't be shorter than the threshold (${days} days) — that would delete activity records before they're used to decide Active/Inactive.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      if (!Number.isInteger(voiceMinutes) || voiceMinutes < 1) {
        return interaction.reply({ content: '❌ Voice minutes must be a whole number, 1 or more.', flags: MessageFlags.Ephemeral });
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
        return interaction.reply({ content: '❌ Pick a quarantine channel in the Channels page first.', flags: MessageFlags.Ephemeral });
      }
      const channel = await interaction.guild.channels.fetch(cfg.quarantineChannelId);
      const { embed: btnEmbed, row: btnRow } = buildReactivationEmbedAndRow();
      await channel.send({ embeds: [btnEmbed], components: [btnRow] });
      return interaction.reply({ content: `✅ Reactivation button posted in **#${channel.name}**.`, flags: MessageFlags.Ephemeral });
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
        const role = await interaction.guild.roles.create({ name: 'Active Member', colors: [0x00cc66], reason: 'Created via /setup — activity tracker' });
        cfg.activeRoleId = role.id;
        saveActivityConfig(activityConfig);
        await interaction.update(buildActivityRolesMenuMessage(guildId));
      } catch (err) {
        console.error('Failed to create Active Member role:', err.message);
        await interaction.reply({ content: `❌ Couldn't create that role — make sure I have the **Manage Roles** permission. (${err.message})`, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (id === 'setup:activity:create-inactive-role') {
      const cfg = ensureActivityGuildConfig(guildId);
      try {
        const role = await interaction.guild.roles.create({ name: 'Inactive Member', colors: [0x999999], reason: 'Created via /setup — activity tracker' });
        cfg.inactiveRoleId = role.id;
        saveActivityConfig(activityConfig);
        await interaction.update(buildActivityRolesMenuMessage(guildId));
      } catch (err) {
        console.error('Failed to create Inactive Member role:', err.message);
        await interaction.reply({ content: `❌ Couldn't create that role — make sure I have the **Manage Roles** permission. (${err.message})`, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (id === 'setup:activity:create-exempt-role') {
      const cfg = ensureActivityGuildConfig(guildId);
      try {
        const role = await interaction.guild.roles.create({ name: 'Activity Tracker Exempt', colors: [0x3498db], reason: 'Created via /setup — activity tracker' });
        cfg.exemptRoleIds.push(role.id);
        saveActivityConfig(activityConfig);
        await interaction.update(buildActivityRolesMenuMessage(guildId));
      } catch (err) {
        console.error('Failed to create activity exempt role:', err.message);
        await interaction.reply({ content: `❌ Couldn't create that role — make sure I have the **Manage Roles** permission. (${err.message})`, flags: MessageFlags.Ephemeral });
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
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch (err) {
        console.error('Failed to create reactivation channel:', err.message);
        await interaction.reply({ content: `❌ Couldn't create that channel — make sure I have the **Manage Channels** permission. (${err.message})`, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (id === 'setup:activity:apply-restrictions') {
      await interaction.deferUpdate(); // this can take a few seconds on a server with many channels
      const result = await applyInactiveChannelRestrictions(interaction.guild);
      if (!result.success) {
        await interaction.followUp({ content: `❌ ${result.reason}`, flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.editReply(buildActivityChannelsMenuMessage(guildId));
      const failedNote = result.failed.length > 0 ? `\n⚠️ Failed on ${result.failed.length} channel(s) — check the bot has **Manage Roles** and can see those channels.` : '';
      await interaction.followUp({
        content: `🔒 Applied to **${result.updated}** channel(s). Inactive is now locked out everywhere except the quarantine channel, and any channel created from now on will be locked down automatically.${failedNote}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  } catch (err) {
    console.error('Error handling /setup interaction:', err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: 'Something went wrong — check the terminal for details.', flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: 'Something went wrong — check the terminal for details.', flags: MessageFlags.Ephemeral });
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
// Stored in channel-index-config.json. Each guild starts with empty defaults
// and configures exclusions via the dashboard.
const CHANNEL_INDEX_CONFIG_FILE = dataPath('channel-index-config.json');

const LEGACY_SEED_EXCLUDED_CATEGORY_IDS = [];
const LEGACY_SEED_EXCLUDED_CHANNEL_IDS = [];
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


// ============================================================
// VC Shuffle System — periodically shuffles users between temporary
// voice channels in randomized groups of 2–5 people every 5–10 min
// ============================================================

const VC_SHUFFLE_CONFIG_FILE = dataPath('vc-shuffle-config.json');

function loadVcShuffleConfig() {
  try {
    return JSON.parse(fs.readFileSync(VC_SHUFFLE_CONFIG_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveVcShuffleConfig(data) {
  try {
    fs.writeFileSync(VC_SHUFFLE_CONFIG_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.error(`Failed to save vc-shuffle-config.json:`, err.message);
    return false;
  }
}

let vcShuffleConfig = loadVcShuffleConfig();

function ensureVcShuffleGuildConfig(guildId) {
  if (!vcShuffleConfig[guildId]) {
    vcShuffleConfig[guildId] = {
      enabled: false,
      lobbyChannelIds: [],    // channels whose current members are pooled for shuffling
      categoryId: null,       // category to create temp rooms in (null = top-level)
      // Speed dating defaults: 1-on-1, 3-minute rounds
      minGroupSize: 1,
      maxGroupSize: 1,
      minIntervalMinutes: 3,
      maxIntervalMinutes: 3,
      announcementChannelId: null, // optional text channel for shuffle announcements
      createdChannelIds: [],   // temp voice channels we made, so we can clean them up
      // Speed dating extras
      participantRoleId: null,    // role assigned when someone joins a lobby; applied to all temp rooms
      staffRoleIds: [],           // staff roles that always get access to temp rooms
      botRoleId: null,            // bot's own managed role for temp room perms
      warningSeconds: 30,         // how many seconds before bell to post the wrap-up warning
      // Permanent event channels (created via "Set Up Event Channels")
      eventCategoryId: null,      // the parent category housing all event channels
      matchupsChannelId: null,    // text channel where round matchups + session summary post
      staffPanelChannelId: null,  // staff-only text channel with live control buttons
      infoChannelId: null,        // member-facing read-only event info channel
      staffPanelMessageId: null,  // message ID of the staff panel so we can update it
    };
    saveVcShuffleConfig(vcShuffleConfig);
  }
  // Normalize configs saved before high-speed-connection fields existed
  if (!vcShuffleConfig[guildId].announcementChannelId) {
    vcShuffleConfig[guildId].announcementChannelId = null;
  }
  if (!vcShuffleConfig[guildId].createdChannelIds) {
    vcShuffleConfig[guildId].createdChannelIds = [];
  }
  if (vcShuffleConfig[guildId].participantRoleId === undefined) {
    vcShuffleConfig[guildId].participantRoleId = null;
  }
  if (!vcShuffleConfig[guildId].staffRoleIds) {
    vcShuffleConfig[guildId].staffRoleIds = [];
  }
  if (vcShuffleConfig[guildId].botRoleId === undefined) {
    vcShuffleConfig[guildId].botRoleId = null;
  }
  if (vcShuffleConfig[guildId].warningSeconds === undefined) {
    vcShuffleConfig[guildId].warningSeconds = 30;
  }
  if (vcShuffleConfig[guildId].eventCategoryId === undefined) vcShuffleConfig[guildId].eventCategoryId = null;
  if (vcShuffleConfig[guildId].matchupsChannelId === undefined) vcShuffleConfig[guildId].matchupsChannelId = null;
  if (vcShuffleConfig[guildId].staffPanelChannelId === undefined) vcShuffleConfig[guildId].staffPanelChannelId = null;
  if (vcShuffleConfig[guildId].infoChannelId === undefined) vcShuffleConfig[guildId].infoChannelId = null;
  if (vcShuffleConfig[guildId].staffPanelMessageId === undefined) vcShuffleConfig[guildId].staffPanelMessageId = null;
  return vcShuffleConfig[guildId];
}

// In-memory shuffle state per guild
// guildId -> { timeoutId, warningTimeoutId, nextShuffleAt, roundNumber, pairHistory: Set<"id1:id2"> }
// pairHistory tracks every pair that has already chatted this session so we avoid rematching them.
const shuffleState = new Map();

// Bell rotation — one fires each round so it never gets old
const BELL_MESSAGES = [
  '🔔 **Time\'s up!** The bell rings — moving everyone to fresh connections...',
  '🔔 **Ding ding!** Round over — rotating to new conversations...',
  '🔔 **Bell\'s ringing!** Hope it was good. Shuffling you into something new...',
  '🔔 **Connection complete.** Time to meet someone new — rotating now...',
  '🔔 **Round over!** Wrapping up and moving on — see you on the flip side...',
];

// Fisher-Yates shuffle
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Split a shuffled array into groups of size between min and max.
// Uses a greedy approach: keep slicing off groups of random size,
// but if the remainder would be smaller than minSize, absorb it into the last group.
function splitIntoGroups(members, minSize, maxSize) {
  const shuffled = shuffleArray(members);
  const groups = [];
  let i = 0;
  while (i < shuffled.length) {
    const remaining = shuffled.length - i;
    if (remaining <= maxSize) {
      groups.push(shuffled.slice(i));
      break;
    }
    const size = Math.floor(Math.random() * (maxSize - minSize + 1)) + minSize;
    groups.push(shuffled.slice(i, i + size));
    i += size;
  }
  return groups;
}

// Canonical pair key — always smaller id first so "A:B" and "B:A" are the same
function pairKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

// Speed-dating pairing: respects anti-repeat history, handles odd overflow as trios.
// groupSize = target people per room (1 = 1-on-1 → creates pairs; 2 = 2v2; 3 = 3v3)
// pairHistory = Set of already-used pair keys for this session
function speedDatePair(members, groupSize, pairHistory) {
  // For 1-on-1: pair people trying to avoid anyone they've already spoken to.
  // For larger groups: use the generic splitter (history still recorded after).
  if (groupSize >= 2) {
    return splitIntoGroups(members, groupSize, groupSize);
  }

  // 1-on-1 mode: Hungarian-style greedy with anti-repeat preference
  const pool = shuffleArray(members); // random starting order
  const paired = new Set();
  const groups = [];

  for (let i = 0; i < pool.length; i++) {
    if (paired.has(pool[i].id)) continue;
    // Find the first unpaired partner we haven't already met
    let partner = null;
    for (let j = i + 1; j < pool.length; j++) {
      if (paired.has(pool[j].id)) continue;
      if (!pairHistory.has(pairKey(pool[i].id, pool[j].id))) {
        partner = pool[j];
        break;
      }
    }
    // Fallback: if everyone is already a repeat, just grab the next unpaired person
    if (!partner) {
      for (let j = i + 1; j < pool.length; j++) {
        if (!paired.has(pool[j].id)) {
          partner = pool[j];
          break;
        }
      }
    }
    if (partner) {
      paired.add(pool[i].id);
      paired.add(partner.id);
      groups.push([pool[i], partner]);
    }
  }

  // Odd person out: fold them into the last group as a trio
  const unpaired = pool.filter((m) => !paired.has(m.id));
  if (unpaired.length && groups.length > 0) {
    groups[groups.length - 1].push(...unpaired);
  } else if (unpaired.length) {
    // Edge case: only 1 person in the whole pool — put them alone
    groups.push(unpaired);
  }

  return groups;
}

// Record every pair in a completed group into the session history
function recordPairs(group, pairHistory) {
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      pairHistory.add(pairKey(group[i].id, group[j].id));
    }
  }
}

// Build the permission overwrites array for a temp high-speed-connection room.
// participantRoleId gets standard VC perms. staffRoleIds get the same.
// botRoleId gets full manage perms. @everyone is denied unless there's no participant role.
function buildRoomPermissions(guild, cfg) {
  const { PermissionFlagsBits: PF } = require('discord.js');
  const overwrites = [];

  // Participant role — the main access gate
  if (cfg.participantRoleId) {
    overwrites.push({
      id: cfg.participantRoleId,
      allow: [
        PF.ViewChannel,
        PF.Connect,
        PF.Speak,
        PF.Stream,
        PF.UseEmbeddedActivities,
        PF.UseSoundboard,
        PF.UseVAD,
        PF.RequestToSpeak,
      ],
    });
    // Deny @everyone — only participants can enter
    overwrites.push({
      id: guild.id,
      deny: [PF.ViewChannel, PF.Connect],
    });
  }

  // Staff roles — same access as participants
  for (const roleId of (cfg.staffRoleIds || [])) {
    overwrites.push({
      id: roleId,
      allow: [
        PF.ViewChannel,
        PF.Connect,
        PF.Speak,
        PF.Stream,
        PF.MoveMembers,
        PF.MuteMembers,
        PF.DeafenMembers,
        PF.ManageChannels,
        PF.UseEmbeddedActivities,
        PF.UseSoundboard,
        PF.UseVAD,
      ],
    });
  }

  // Bot role — needs move/manage to do its job
  if (cfg.botRoleId) {
    overwrites.push({
      id: cfg.botRoleId,
      allow: [
        PF.ViewChannel,
        PF.Connect,
        PF.MoveMembers,
        PF.ManageChannels,
        PF.ManageRoles,
      ],
    });
  }

  return overwrites;
}

// Collect all human members currently in any of the lobby channels
function collectPoolMembers(guild, cfg) {
  const members = [];
  const seen = new Set();
  for (const channelId of cfg.lobbyChannelIds) {
    const ch = guild.channels.cache.get(channelId);
    if (!ch) continue;
    for (const member of ch.members.values()) {
      if (member.user.bot) continue;
      if (seen.has(member.id)) continue;
      seen.add(member.id);
      members.push(member);
    }
  }
  return members;
}

// Delete all temporary shuffle channels we created for a guild
async function cleanupShuffleChannels(guild, cfg) {
  const toDelete = [...cfg.createdChannelIds];
  cfg.createdChannelIds = [];
  saveVcShuffleConfig(vcShuffleConfig);
  for (const id of toDelete) {
    try {
      const ch = guild.channels.cache.get(id);
      if (ch) await ch.delete('VC Shuffle session ended');
    } catch (err) {
      console.error(`[vc-shuffle] Could not delete temp channel ${id} in guild ${guild.id}:`, err.message);
    }
  }
}

// Move everyone in our temp channels back to the first lobby channel, then delete them
async function moveEveryoneToLobby(guild, cfg) {
  if (!cfg.lobbyChannelIds.length) return;
  const lobby = guild.channels.cache.get(cfg.lobbyChannelIds[0]);
  if (!lobby) return;

  for (const channelId of cfg.createdChannelIds) {
    const ch = guild.channels.cache.get(channelId);
    if (!ch) continue;
    for (const member of ch.members.values()) {
      try {
        await member.voice.setChannel(lobby, 'VC Shuffle: returning to lobby');
      } catch (err) {
        console.error(`[vc-shuffle] Could not move member ${member.id} to lobby:`, err.message);
      }
    }
  }
}

// Core high-speed-connection round: anti-repeat pairing, named rooms, perms, participant role, warning timer
async function runShuffleRound(guild, guildId) {
  const cfg = ensureVcShuffleGuildConfig(guildId);
  if (!cfg.enabled) return;
  if (!cfg.lobbyChannelIds.length) return;

  const state = shuffleState.get(guildId);
  if (!state) return;

  // Cancel any pending warning timer from the previous round
  if (state.warningTimeoutId) { clearTimeout(state.warningTimeoutId); state.warningTimeoutId = null; }

  state.roundNumber = (state.roundNumber || 0) + 1;
  const round = state.roundNumber;
  if (!state.pairHistory) state.pairHistory = new Set();

  console.log(`[vc-shuffle] Guild ${guildId}: starting round #${round}`);

  // Collect pool from lobby AND any active cloud rooms (direct swap — no lobby bounce)
  const cloudRoomIds = cfg.cloudRoomIds || [];
  const allSourceIds = [...cfg.lobbyChannelIds, ...cloudRoomIds];
  const seen = new Set();
  const pool = [];
  for (const chId of allSourceIds) {
    const ch = guild.channels.cache.get(chId);
    if (!ch) continue;
    for (const member of ch.members.values()) {
      if (member.user.bot || seen.has(member.id)) continue;
      seen.add(member.id);
      pool.push(member);
    }
  }

  const matchupTarget = cfg.matchupsChannelId || cfg.announcementChannelId;
  const matchupCh = matchupTarget ? guild.channels.cache.get(matchupTarget) : null;

  if (pool.length < 2) {
    console.log(`[vc-shuffle] Guild ${guildId}: only ${pool.length} member(s) — skipping round`);
    if (matchupCh) {
      const msg = await matchupCh.send(`⚠️ Not enough people in the lobby for Round #${round} — waiting for more to join!`).catch(() => null);
      if (msg) setTimeout(() => msg.delete().catch(() => {}), 15000);
    }
    scheduleNextShuffle(guild, guildId);
    return;
  }

  // Assign participant role
  if (cfg.participantRoleId) {
    for (const member of pool) {
      if (!member.roles.cache.has(cfg.participantRoleId))
        await member.roles.add(cfg.participantRoleId, '💨 HSC: joined session').catch(() => {});
    }
  }

  // Pair members
  const targetSize = cfg.minGroupSize ?? 1;
  const groups = speedDatePair(pool, targetSize, state.pairHistory);
  for (const group of groups) recordPairs(group, state.pairHistory);

  // Countdown on round 1
  if (round === 1 && matchupCh) {
    for (const num of ['5️⃣', '4️⃣', '3️⃣', '2️⃣', '1️⃣']) {
      const m = await matchupCh.send(num).catch(() => null);
      await new Promise((r) => setTimeout(r, 1000));
      if (m) m.delete().catch(() => {});
    }
    const goMsg = await matchupCh.send('💨 **GO!**').catch(() => null);
    if (goMsg) setTimeout(() => goMsg.delete().catch(() => {}), 3000);
  }

  // Direct swap into cloud rooms — no create/delete, just move people room to room
  const { PermissionFlagsBits: PF } = require('discord.js');
  const activeRoomIds = [];

  for (let i = 0; i < groups.length; i++) {
    let roomCh = cloudRoomIds[i] ? guild.channels.cache.get(cloudRoomIds[i]) : null;

    if (!roomCh) {
      // More groups than pre-created rooms — create an overflow room
      try {
        roomCh = await guild.channels.create({
          name: `💨・ᴄʟᴏᴜᴅ・ʀᴏᴏᴍ・${i + 1}`,
          type: ChannelType.GuildVoice,
          parent: cfg.categoryId || null,
          reason: `💨 HSC round #${round} overflow`,
        });
        if (!cfg.cloudRoomIds) cfg.cloudRoomIds = [];
        cfg.cloudRoomIds.push(roomCh.id);
      } catch (err) {
        console.error(`[vc-shuffle] Could not create overflow room ${i + 1}: ${err.message}`);
        continue;
      }
    }

    activeRoomIds.push(roomCh.id);

    // Grant each assigned member user-level Connect on this room before moving
    for (const member of groups[i]) {
      await roomCh.permissionOverwrites.edit(member, { ViewChannel: true, Connect: true, Speak: true })
        .catch((err) => console.warn(`[vc-shuffle] Perm edit failed for ${member.id}: ${err.message}`));
    }

    // Move directly — no lobby bounce
    for (const member of groups[i]) {
      await member.voice.setChannel(roomCh, `💨 HSC round #${round}`)
        .catch((err) => console.error(`[vc-shuffle] Could not move ${member.id}: ${err.message}`));
    }
  }

  // Move anyone left in unused cloud rooms back to lobby
  const lobby = guild.channels.cache.get(cfg.lobbyChannelIds[0]);
  for (let i = groups.length; i < cloudRoomIds.length; i++) {
    const roomCh = guild.channels.cache.get(cloudRoomIds[i]);
    if (!roomCh) continue;
    for (const member of roomCh.members.values()) {
      if (member.user.bot) continue;
      if (lobby) await member.voice.setChannel(lobby, '💨 Moved to lobby — room unused this round').catch(() => {});
    }
  }

  cfg.createdChannelIds = activeRoomIds; // keep for solo rescue listener
  saveVcShuffleConfig(vcShuffleConfig);

  // Post matchups with clickable @mentions
  if (matchupCh) {
    try {
      const groupLines = groups.map((g, i) => {
        const names = g.map((m) => `<@${m.id}>`).join(' ↔ ');
        return `💨・ᴄʟᴏᴜᴅ・ʀᴏᴏᴍ・${i + 1} — ${names}${g.length > 2 ? ' *(trio)*' : ''}`;
      }).join('\n');

      const allMet = pool.length > 1 && state.pairHistory.size >= (pool.length * (pool.length - 1)) / 2;

      const embed = new EmbedBuilder()
        .setColor(0x8a2be2)
        .setTitle(`💨 Round #${round} Matchups`)
        .setDescription(`**${pool.length}** people · **${groups.length}** room${groups.length !== 1 ? 's' : ''}\n\n${groupLines}${allMet ? '\n\n🎉 Everyone\'s met everyone — resetting pair history!' : ''}`)
        .setFooter({ text: `~${cfg.minIntervalMinutes ?? 3} min per round · Toggle cam off/on if it dropped` })
        .setTimestamp();
      await matchupCh.send({ embeds: [embed] });
      if (allMet) state.pairHistory = new Set();
    } catch (err) {
      console.error(`[vc-shuffle] Could not post matchups: ${err.message}`);
    }
  }

  await refreshStaffPanel(guild, guildId);

  // Schedule 30-second warning (auto-deletes)
  const roundMs = (cfg.minIntervalMinutes ?? 3) * 60 * 1000;
  const warnSecs = cfg.warningSeconds ?? 30;
  const warnMs = Math.max(0, roundMs - warnSecs * 1000);

  const warningTimeoutId = warnMs > 0 ? setTimeout(async () => {
    const warnCh = matchupTarget ? guild.channels.cache.get(matchupTarget) : null;
    if (warnCh) {
      const warnMsg = await warnCh.send(`⏰ **${warnSecs} seconds left!** Wrap it up — the bell rings soon! 🔔`).catch(() => null);
      if (warnMsg) setTimeout(() => warnMsg.delete().catch(() => {}), Math.max(0, (warnSecs - 3) * 1000));
    }
  }, warnMs) : null;

  const cur = shuffleState.get(guildId) || state;
  cur.warningTimeoutId = warningTimeoutId;
  shuffleState.set(guildId, cur);

  console.log(`[vc-shuffle] Guild ${guildId}: round #${round} — ${pool.length} people in ${groups.length} rooms`);
}

// Build the staff panel embed + button row
function buildStaffPanelContent(guildId) {
  const cfg = ensureVcShuffleGuildConfig(guildId);
  const state = shuffleState.get(guildId);
  const running = cfg.enabled;
  const round = state?.roundNumber ?? 0;
  const pairs = state?.pairHistory?.size ?? 0;
  const nextAt = state?.nextShuffleAt ? `<t:${Math.floor(state.nextShuffleAt / 1000)}:R>` : '—';
  const mode = (cfg.minGroupSize ?? 1) === 1 ? '1-on-1' : `${cfg.minGroupSize}v${cfg.minGroupSize}`;

  const embed = new EmbedBuilder()
    .setColor(running ? 0x8a2be2 : 0x555555)
    .setTitle('💨 High-Speed Connection — Master Panel')
    .setDescription('Live event controls. Use buttons below to manage the session.')
    .addFields(
      { name: 'Status',       value: running ? '🟢 Running' : '🔴 Stopped', inline: true },
      { name: 'Round',        value: String(round),                          inline: true },
      { name: 'Mode',         value: mode,                                   inline: true },
      { name: 'Round length', value: `${cfg.minIntervalMinutes ?? 3}m`,      inline: true },
      { name: 'Next bell',    value: running ? nextAt : '—',                inline: true },
      { name: 'Unique pairs', value: String(pairs),                          inline: true },
    )
    .setFooter({ text: 'Auto-updates each round · 💨・ᴍᴀsᴛᴇʀ・ᴘᴀɴᴇʟ' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('spdating:start').setLabel('▶️ Start').setStyle(ButtonStyle.Success).setDisabled(running),
    new ButtonBuilder().setCustomId('spdating:bell').setLabel('🔔 Next Round').setStyle(ButtonStyle.Primary).setDisabled(!running),
    new ButtonBuilder().setCustomId('spdating:stop').setLabel('⏹️ End Session').setStyle(ButtonStyle.Danger).setDisabled(!running),
  );

  return { embeds: [embed], components: [row] };
}

// Send or update the staff panel message
async function refreshStaffPanel(guild, guildId) {
  const cfg = ensureVcShuffleGuildConfig(guildId);
  if (!cfg.staffPanelChannelId) return;
  try {
    const ch = guild.channels.cache.get(cfg.staffPanelChannelId);
    if (!ch) return;
    const content = buildStaffPanelContent(guildId);
    if (cfg.staffPanelMessageId) {
      try {
        const msg = await ch.messages.fetch(cfg.staffPanelMessageId);
        await msg.edit(content);
        return;
      } catch { /* deleted — post fresh */ }
    }
    const msg = await ch.send(content);
    cfg.staffPanelMessageId = msg.id;
    saveVcShuffleConfig(vcShuffleConfig);
  } catch (err) {
    console.error(`[vc-shuffle] Could not refresh staff panel: ${err.message}`);
  }
}

// Post bell message (auto-deletes after 10s)
async function postBellMessage(guild, guildId) {
  const cfg = ensureVcShuffleGuildConfig(guildId);
  const target = cfg.matchupsChannelId || cfg.announcementChannelId;
  if (!target) return;
  try {
    const textCh = guild.channels.cache.get(target);
    if (!textCh) return;
    const state = shuffleState.get(guildId);
    const bellMsg = BELL_MESSAGES[(state?.roundNumber ?? 0) % BELL_MESSAGES.length];
    const msg = await textCh.send(bellMsg);
    setTimeout(() => msg.delete().catch(() => {}), 10000);
  } catch (err) {
    console.error(`[vc-shuffle] Could not post bell: ${err.message}`);
  }
}

// Random interval ms between min and max configured minutes
function randomIntervalMs(cfg) {
  const min = (cfg.minIntervalMinutes ?? 3) * 60 * 1000;
  const max = (cfg.maxIntervalMinutes ?? cfg.minIntervalMinutes ?? 3) * 60 * 1000;
  return Math.max(min, Math.floor(Math.random() * (max - min + 1)) + min);
}

function scheduleNextShuffle(guild, guildId) {
  const cfg = ensureVcShuffleGuildConfig(guildId);
  if (!cfg.enabled) return;

  // Speed dating uses a fixed round length — min and max are the same (set-interval still works)
  const delay = randomIntervalMs(cfg);
  const nextAt = Date.now() + delay;

  const state = shuffleState.get(guildId) || {};
  if (state.timeoutId) clearTimeout(state.timeoutId);
  if (state.warningTimeoutId) clearTimeout(state.warningTimeoutId);

  const timeoutId = setTimeout(async () => {
    try {
      // Ring the bell before we move anyone
      await postBellMessage(guild, guildId);
      await runShuffleRound(guild, guildId);
    } catch (err) {
      console.error(`[vc-shuffle] Uncaught error in shuffle round for guild ${guildId}:`, err.message);
    }
    // Reschedule after each round (re-reads config so changes take effect immediately)
    const freshCfg = ensureVcShuffleGuildConfig(guildId);
    if (freshCfg.enabled) {
      scheduleNextShuffle(guild, guildId);
    } else {
      shuffleState.delete(guildId);
    }
  }, delay);

  shuffleState.set(guildId, { ...state, timeoutId, warningTimeoutId: null, nextShuffleAt: nextAt });
  console.log(`[vc-shuffle] Guild ${guildId}: next round in ${Math.round(delay / 1000)}s (at ${new Date(nextAt).toISOString()})`);
}

// Start shuffle for a guild
async function startVcShuffle(guild, guildId, runImmediately = false) {
  const cfg = ensureVcShuffleGuildConfig(guildId);
  cfg.enabled = true;
  saveVcShuffleConfig(vcShuffleConfig);

  // Clear any existing timer and reset session state including pair history
  const existing = shuffleState.get(guildId);
  if (existing?.timeoutId) clearTimeout(existing.timeoutId);
  if (existing?.warningTimeoutId) clearTimeout(existing.warningTimeoutId);
  shuffleState.set(guildId, { roundNumber: 0, pairHistory: new Set() });

  if (runImmediately) {
    await runShuffleRound(guild, guildId);
  }
  scheduleNextShuffle(guild, guildId);
}

// Stop shuffle for a guild — ring the final bell, post session summary, clean up
async function stopVcShuffle(guild, guildId) {
  const cfg = ensureVcShuffleGuildConfig(guildId);
  cfg.enabled = false;
  saveVcShuffleConfig(vcShuffleConfig);

  const state = shuffleState.get(guildId);
  if (state?.timeoutId) clearTimeout(state.timeoutId);
  if (state?.warningTimeoutId) clearTimeout(state.warningTimeoutId);

  // Move everyone back to lobby then cleanup
  await moveEveryoneToLobby(guild, cfg);
  await cleanupShuffleChannels(guild, cfg);

  // Strip the participant role from everyone in the lobby channels
  if (cfg.participantRoleId) {
    for (const channelId of cfg.lobbyChannelIds) {
      const ch = guild.channels.cache.get(channelId);
      if (!ch) continue;
      for (const member of ch.members.values()) {
        try {
          if (member.roles.cache.has(cfg.participantRoleId)) {
            await member.roles.remove(cfg.participantRoleId, '💨 High-Speed Connection: session ended');
          }
        } catch (err) {
          console.error(`[vc-shuffle] Could not remove participant role from ${member.id}:`, err.message);
        }
      }
    }
  }

  // Post session summary — prefer matchups channel, fall back to announcement channel
  const summaryTarget = cfg.matchupsChannelId || cfg.announcementChannelId;
  if (summaryTarget && state?.pairHistory) {
    try {
      const textCh = guild.channels.cache.get(summaryTarget);
      if (textCh) {
        const rounds = state.roundNumber ?? 0;
        const pairs = state.pairHistory.size;
        const embed = new EmbedBuilder()
          .setColor(0x8a2be2)
          .setTitle('💨 High-Speed Connection — Session Over')
          .setDescription(
            `That's a wrap!\n\n` +
            `**Rounds completed:** ${rounds}\n` +
            `**Unique connections made:** ${pairs}\n\n` +
            `Everyone has been returned to the lobby. Hope you made some good connections.`
          )
          .setTimestamp();
        await textCh.send({ embeds: [embed] });
      }
    } catch (err) {
      console.error(`[vc-shuffle] Could not post session summary in guild ${guildId}:`, err.message);
    }
  }

  shuffleState.delete(guildId);

  // Refresh staff panel to show stopped state
  await refreshStaffPanel(guild, guildId);
}

// Re-arm shuffles on bot restart for any guild that had it enabled
client.once('clientReady', () => {
  for (const [guildId, cfg] of Object.entries(vcShuffleConfig)) {
    if (!cfg.enabled) continue;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    console.log(`[vc-shuffle] Resuming shuffle for guild ${guildId}`);
    shuffleState.set(guildId, { roundNumber: 0 });
    scheduleNextShuffle(guild, guildId);
  }
});

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
    .setName('vc-shuffle')
    .setDescription('Randomly shuffle voice channel members into small groups every 5–10 minutes')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('start')
        .setDescription('Start the VC shuffle session (runs the first shuffle immediately)')
    )
    .addSubcommand((sub) => sub.setName('stop').setDescription('Stop the VC shuffle session and clean up temp channels'))
    .addSubcommand((sub) => sub.setName('status').setDescription('Show current shuffle configuration and state'))
    .addSubcommand((sub) =>
      sub
        .setName('set-group-size')
        .setDescription('Set the min and max members per shuffle group (default: 2–5)')
        .addIntegerOption((opt) => opt.setName('min').setDescription('Minimum group size').setRequired(true).setMinValue(2).setMaxValue(10))
        .addIntegerOption((opt) => opt.setName('max').setDescription('Maximum group size').setRequired(true).setMinValue(2).setMaxValue(20))
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-interval')
        .setDescription('Set the min and max shuffle interval in minutes (default: 5–10)')
        .addIntegerOption((opt) => opt.setName('min').setDescription('Minimum minutes between shuffles').setRequired(true).setMinValue(1).setMaxValue(60))
        .addIntegerOption((opt) => opt.setName('max').setDescription('Maximum minutes between shuffles').setRequired(true).setMinValue(1).setMaxValue(60))
    )
    .addSubcommand((sub) =>
      sub
        .setName('add-lobby')
        .setDescription('Add a voice channel to the shuffle pool (members here are eligible to be shuffled)')
        .addChannelOption((opt) => opt.setName('channel').setDescription('Voice channel to add as a lobby/pool source').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove-lobby')
        .setDescription('Remove a voice channel from the shuffle pool')
        .addChannelOption((opt) => opt.setName('channel').setDescription('Voice channel to remove').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-category')
        .setDescription('Set the category where temp shuffle rooms are created (leave unset for top-level)')
        .addChannelOption((opt) => opt.setName('category').setDescription('Category channel').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-announce')
        .setDescription('Set a text channel to post 💨 high-speed connection round announcements in')
        .addChannelOption((opt) => opt.setName('channel').setDescription('Text channel for announcements').setRequired(true))
    )
    .addSubcommand((sub) => sub.setName('shuffle-now').setDescription('Ring the bell and start a new round immediately'))
    .addSubcommand((sub) =>
      sub
        .setName('set-participant-role')
        .setDescription('Role assigned to members when they enter the lobby; applied to all temp rooms')
        .addRoleOption((opt) => opt.setName('role').setDescription('The participant role').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('add-staff-role')
        .setDescription('Add a staff role that always gets access to temp high-speed-connection rooms')
        .addRoleOption((opt) => opt.setName('role').setDescription('Staff role').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove-staff-role')
        .setDescription('Remove a staff role from the temp room access list')
        .addRoleOption((opt) => opt.setName('role').setDescription('Staff role').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-bot-role')
        .setDescription("Set the bot's managed role so it keeps manage perms in temp rooms")
        .addRoleOption((opt) => opt.setName('role').setDescription("The bot's role").setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-warning-seconds')
        .setDescription('Seconds before the bell to post a wrap-up warning (default: 30)')
        .addIntegerOption((opt) => opt.setName('seconds').setDescription('Seconds before bell').setRequired(true).setMinValue(5).setMaxValue(300))
    )
    .addSubcommand((sub) => sub.setName('end-session').setDescription('End the session, post the summary, and clean up all rooms')),
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

client.once('clientReady', async () => {
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
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
      const effectiveIds = getEffectiveMonitoredChannelIds(interaction.guildId, interaction.guild);
      const embed = new EmbedBuilder()
        .setColor(cfg.enabled ? 0x00cc66 : 0x999999)
        .setTitle('📷 Camera Policy Status')
        .addFields(
          { name: 'Enabled', value: cfg.enabled ? 'Yes' : 'No', inline: true },
          { name: 'Grace period', value: `${cfg.graceMinutes ?? DEFAULT_GRACE_MINUTES} minute(s)`, inline: true },
          { name: 'Warning period', value: `${cfg.warningMinutes ?? DEFAULT_WARNING_MINUTES} minute(s)`, inline: true },
          {
            name: `Monitored channels (${cfg.monitoredChannels.length} explicit, ${effectiveIds.size} effective)`,
            value: cfg.monitoredChannels.length ? cfg.monitoredChannels.map((id) => `<#${id}>`).join(', ') : 'None',
          },
          {
            name: `Monitored categories (${cfg.monitoredCategoryIds?.length ?? 0})`,
            value: cfg.monitoredCategoryIds?.length ? cfg.monitoredCategoryIds.map((id) => `<#${id}>`).join(', ') : 'None — all voice in these categories auto-monitored',
          },
          {
            name: `Exempt roles (${cfg.exemptRoles.length})`,
            value: cfg.exemptRoles.length ? cfg.exemptRoles.map((id) => `<@&${id}>`).join(', ') : 'None',
          },
          { name: 'Announcement link', value: cfg.announcementUrl ? cfg.announcementUrl : 'Not set' }
        );
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === 'camera-monitor') {
      const sub = interaction.options.getSubcommand();
      const guildConfig = ensureGuildConfig(interaction.guildId);

      if (sub === 'add') {
        const channel = interaction.options.getChannel('channel');
        if (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice) {
          await interaction.reply({ content: '❌ That needs to be a voice channel.', flags: MessageFlags.Ephemeral });
        } else if (guildConfig.monitoredChannels.includes(channel.id)) {
          await interaction.reply({ content: `**#${channel.name}** is already being monitored.`, flags: MessageFlags.Ephemeral });
        } else {
          guildConfig.monitoredChannels.push(channel.id);
          saveCameraConfig(cameraConfig);
          await interaction.reply(`✅ Now monitoring **#${channel.name}** for the cameras-on policy.`);
        }
      } else if (sub === 'remove') {
        const channel = interaction.options.getChannel('channel');
        if (!guildConfig.monitoredChannels.includes(channel.id)) {
          await interaction.reply({ content: `**#${channel.name}** wasn't being monitored.`, flags: MessageFlags.Ephemeral });
        } else {
          guildConfig.monitoredChannels = guildConfig.monitoredChannels.filter((id) => id !== channel.id);
          saveCameraConfig(cameraConfig);
          await interaction.reply(`✅ Stopped monitoring **#${channel.name}**.`);
        }
      } else if (sub === 'list') {
        if (guildConfig.monitoredChannels.length === 0) {
          await interaction.reply({ content: 'No voice channels are currently being monitored in this server.', flags: MessageFlags.Ephemeral });
        } else {
          const list = guildConfig.monitoredChannels.map((id) => `<#${id}>`).join('\n');
          await interaction.reply({ content: `**Monitored voice channels:**\n${list}`, flags: MessageFlags.Ephemeral });
        }
      }
    }

    if (interaction.commandName === 'camera-exempt-role') {
      const sub = interaction.options.getSubcommand();
      const guildConfig = ensureGuildConfig(interaction.guildId);

      if (sub === 'add') {
        const role = interaction.options.getRole('role');
        if (guildConfig.exemptRoles.includes(role.id)) {
          await interaction.reply({ content: `**${role.name}** is already exempt.`, flags: MessageFlags.Ephemeral });
        } else {
          guildConfig.exemptRoles.push(role.id);
          saveCameraConfig(cameraConfig);
          await interaction.reply(`✅ **${role.name}** is now exempt from the cameras-on policy.`);
        }
      } else if (sub === 'remove') {
        const role = interaction.options.getRole('role');
        if (!guildConfig.exemptRoles.includes(role.id)) {
          await interaction.reply({ content: `**${role.name}** wasn't exempt.`, flags: MessageFlags.Ephemeral });
        } else {
          guildConfig.exemptRoles = guildConfig.exemptRoles.filter((id) => id !== role.id);
          saveCameraConfig(cameraConfig);
          await interaction.reply(`✅ **${role.name}** is no longer exempt.`);
        }
      } else if (sub === 'list') {
        if (guildConfig.exemptRoles.length === 0) {
          await interaction.reply({ content: 'No roles are currently exempt in this server.', flags: MessageFlags.Ephemeral });
        } else {
          const list = guildConfig.exemptRoles.map((id) => `<@&${id}>`).join('\n');
          await interaction.reply({ content: `**Exempt roles:**\n${list}`, flags: MessageFlags.Ephemeral });
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
          flags: MessageFlags.Ephemeral,
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
          flags: MessageFlags.Ephemeral,
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
            await interaction.reply({ content: `**${role.name}** is already exempt.`, flags: MessageFlags.Ephemeral });
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
          await interaction.reply({ content: `**Exempt roles:**\n${list}`, flags: MessageFlags.Ephemeral });
        }
        return;
      }

      if (sub === 'enable') {
        if (!guildConfig.activeRoleId || !guildConfig.inactiveRoleId) {
          await interaction.reply({ content: '❌ Set your roles first with `/activity-tracker set-roles`.', flags: MessageFlags.Ephemeral });
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
            flags: MessageFlags.Ephemeral,
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
          flags: MessageFlags.Ephemeral,
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
          await interaction.reply({ content: '❌ Set a quarantine channel first with `/activity-tracker set-quarantine-channel`.', flags: MessageFlags.Ephemeral });
        } else {
          const channel = await interaction.guild.channels.fetch(guildConfig.quarantineChannelId);
          const { embed, row } = buildReactivationEmbedAndRow();
          await channel.send({ embeds: [embed], components: [row] });
          await interaction.reply({ content: `✅ Button posted in **#${channel.name}**.`, flags: MessageFlags.Ephemeral });
        }
      } else if (sub === 'apply-restrictions') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }); // this can take a few seconds on a large server
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
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
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
          flags: MessageFlags.Ephemeral,
        });
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
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (followUpErr) {
      // If we can't even respond (e.g. interaction expired), just log and move on
      console.error('Could not send error response to Discord:', followUpErr.message);
    }
  }
});

// ============================================================
// VC Shuffle — slash command interaction handler
// ============================================================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'vc-shuffle') return;

  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;
  const guild = interaction.guild;
  const cfg = ensureVcShuffleGuildConfig(guildId);

  try {
    if (sub === 'start') {
      if (!cfg.lobbyChannelIds.length) {
        return interaction.reply({ content: '❌ Add at least one lobby/pool channel first with `/vc-shuffle add-lobby`.', flags: MessageFlags.Ephemeral });
      }
      await interaction.deferReply();
      await startVcShuffle(guild, guildId, true);
      const state = shuffleState.get(guildId);
      const nextIn = state?.nextShuffleAt ? Math.round((state.nextShuffleAt - Date.now()) / 1000 / 60) : '?';
      await interaction.editReply(`🔀 **VC Shuffle started!** First round complete. Next shuffle in ~${nextIn} minute(s). Use \`/vc-shuffle stop\` to end the session.`);
    }

    else if (sub === 'stop') {
      await interaction.deferReply();
      await stopVcShuffle(guild, guildId);
      await interaction.editReply(`⏹️ **VC Shuffle stopped.** Everyone's been moved back to the lobby and temp rooms deleted.`);
    }

    else if (sub === 'shuffle-now') {
      await interaction.deferReply();
      // Cancel any pending warning timer — manual move resets the clock
      const state = shuffleState.get(guildId);
      if (state?.warningTimeoutId) {
        clearTimeout(state.warningTimeoutId);
        if (state) state.warningTimeoutId = null;
      }
      await postBellMessage(guild, guildId);
      await runShuffleRound(guild, guildId);
      // Reset the next scheduled round timer too
      scheduleNextShuffle(guild, guildId);
      await interaction.editReply(`🔔 **Bell rung manually!** Everyone's been moved to fresh connections. Timer reset.`);
    }

    else if (sub === 'end-session') {
      await interaction.deferReply();
      await stopVcShuffle(guild, guildId);
      await interaction.editReply(`⏹️ **💨 High-Speed Connection session ended.** Summary posted in the announcement channel (if set).`);
    }

    else if (sub === 'set-participant-role') {
      const role = interaction.options.getRole('role');
      cfg.participantRoleId = role.id;
      saveVcShuffleConfig(vcShuffleConfig);
      await interaction.reply(`✅ **${role.name}** set as the participant role. Members get it on lobby join; all temp rooms will be locked to it.`);
    }

    else if (sub === 'add-staff-role') {
      const role = interaction.options.getRole('role');
      if (!cfg.staffRoleIds) cfg.staffRoleIds = [];
      if (cfg.staffRoleIds.includes(role.id)) {
        return interaction.reply({ content: `**${role.name}** is already a staff role.`, flags: MessageFlags.Ephemeral });
      }
      cfg.staffRoleIds.push(role.id);
      saveVcShuffleConfig(vcShuffleConfig);
      await interaction.reply(`✅ **${role.name}** added to staff roles — will get access to all temp rooms.`);
    }

    else if (sub === 'remove-staff-role') {
      const role = interaction.options.getRole('role');
      if (!cfg.staffRoleIds?.includes(role.id)) {
        return interaction.reply({ content: `**${role.name}** isn't in the staff role list.`, flags: MessageFlags.Ephemeral });
      }
      cfg.staffRoleIds = cfg.staffRoleIds.filter((id) => id !== role.id);
      saveVcShuffleConfig(vcShuffleConfig);
      await interaction.reply(`✅ **${role.name}** removed from staff roles.`);
    }

    else if (sub === 'set-bot-role') {
      const role = interaction.options.getRole('role');
      cfg.botRoleId = role.id;
      saveVcShuffleConfig(vcShuffleConfig);
      await interaction.reply(`✅ Bot role set to **${role.name}** — it'll have manage perms in all temp rooms.`);
    }

    else if (sub === 'set-warning-seconds') {
      const seconds = interaction.options.getInteger('seconds');
      cfg.warningSeconds = seconds;
      saveVcShuffleConfig(vcShuffleConfig);
      await interaction.reply(`✅ Wrap-up warning will fire **${seconds} seconds** before the bell.`);
    }

    else if (sub === 'status') {
      const state = shuffleState.get(guildId);
      const nextIn = state?.nextShuffleAt ? `<t:${Math.floor(state.nextShuffleAt / 1000)}:R>` : 'N/A';
      const groupModeLabel = cfg.minGroupSize === 1 ? '1-on-1 (💨 high-speed connection)' : `${cfg.minGroupSize}v${cfg.minGroupSize}`;
      const embed = new EmbedBuilder()
        .setColor(cfg.enabled ? 0x8a2be2 : 0x999999)
        .setTitle('💨 High-Speed Connection — Status')
        .addFields(
          { name: 'Running', value: cfg.enabled ? '🟢 Yes' : '🔴 No', inline: true },
          { name: 'Round #', value: String(state?.roundNumber ?? 0), inline: true },
          { name: 'Next bell', value: cfg.enabled ? nextIn : 'Not scheduled', inline: true },
          { name: 'Mode', value: groupModeLabel, inline: true },
          { name: 'Round length', value: `${cfg.minIntervalMinutes} min`, inline: true },
          { name: 'Warn before bell', value: `${cfg.warningSeconds ?? 30}s`, inline: true },
          { name: 'Unique pairs this session', value: String(state?.pairHistory?.size ?? 0), inline: true },
          { name: 'Active temp rooms', value: String(cfg.createdChannelIds.length), inline: true },
          { name: 'Lobby channels', value: cfg.lobbyChannelIds.length ? cfg.lobbyChannelIds.map((id) => `<#${id}>`).join(', ') : 'None set', inline: false },
          { name: 'Participant role', value: cfg.participantRoleId ? `<@&${cfg.participantRoleId}>` : 'Not set', inline: true },
          { name: 'Staff roles', value: cfg.staffRoleIds?.length ? cfg.staffRoleIds.map((id) => `<@&${id}>`).join(', ') : 'None', inline: true },
          { name: 'Bot role', value: cfg.botRoleId ? `<@&${cfg.botRoleId}>` : 'Not set', inline: true },
          { name: 'Announcement channel', value: cfg.announcementChannelId ? `<#${cfg.announcementChannelId}>` : 'Not set', inline: true },
          { name: 'Room category', value: cfg.categoryId ? `<#${cfg.categoryId}>` : 'Top-level', inline: true },
        );
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    else if (sub === 'set-group-size') {
      const min = interaction.options.getInteger('min');
      const max = interaction.options.getInteger('max');
      if (min > max) {
        return interaction.reply({ content: '❌ Min must be ≤ max.', flags: MessageFlags.Ephemeral });
      }
      cfg.minGroupSize = min;
      cfg.maxGroupSize = max;
      saveVcShuffleConfig(vcShuffleConfig);
      await interaction.reply(`✅ Group size set to **${min}–${max}** people per room.`);
    }

    else if (sub === 'set-interval') {
      const min = interaction.options.getInteger('min');
      const max = interaction.options.getInteger('max');
      if (min > max) {
        return interaction.reply({ content: '❌ Min must be ≤ max.', flags: MessageFlags.Ephemeral });
      }
      cfg.minIntervalMinutes = min;
      cfg.maxIntervalMinutes = max;
      saveVcShuffleConfig(vcShuffleConfig);
      await interaction.reply(`✅ Shuffle interval set to **${min}–${max}** minutes (randomized each round).`);
    }

    else if (sub === 'add-lobby') {
      const channel = interaction.options.getChannel('channel');
      if (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice) {
        return interaction.reply({ content: '❌ That needs to be a voice channel.', flags: MessageFlags.Ephemeral });
      }
      if (cfg.lobbyChannelIds.includes(channel.id)) {
        return interaction.reply({ content: `**${channel.name}** is already a lobby channel.`, flags: MessageFlags.Ephemeral });
      }
      cfg.lobbyChannelIds.push(channel.id);
      saveVcShuffleConfig(vcShuffleConfig);
      await interaction.reply(`✅ **${channel.name}** added as a lobby/pool channel — members in here will be eligible for shuffling.`);
    }

    else if (sub === 'remove-lobby') {
      const channel = interaction.options.getChannel('channel');
      if (!cfg.lobbyChannelIds.includes(channel.id)) {
        return interaction.reply({ content: `**${channel.name}** isn't a lobby channel.`, flags: MessageFlags.Ephemeral });
      }
      cfg.lobbyChannelIds = cfg.lobbyChannelIds.filter((id) => id !== channel.id);
      saveVcShuffleConfig(vcShuffleConfig);
      await interaction.reply(`✅ **${channel.name}** removed from the shuffle pool.`);
    }

    else if (sub === 'set-category') {
      const channel = interaction.options.getChannel('category');
      if (channel.type !== ChannelType.GuildCategory) {
        return interaction.reply({ content: '❌ That needs to be a category, not a voice or text channel.', flags: MessageFlags.Ephemeral });
      }
      cfg.categoryId = channel.id;
      saveVcShuffleConfig(vcShuffleConfig);
      await interaction.reply(`✅ Temp shuffle rooms will be created inside **${channel.name}**.`);
    }

    else if (sub === 'set-announce') {
      const channel = interaction.options.getChannel('channel');
      if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
        return interaction.reply({ content: '❌ That needs to be a text channel.', flags: MessageFlags.Ephemeral });
      }
      cfg.announcementChannelId = channel.id;
      saveVcShuffleConfig(vcShuffleConfig);
      await interaction.reply(`✅ Shuffle round announcements will be posted in <#${channel.id}>.`);
    }

  } catch (err) {
    console.error('[vc-shuffle] Interaction error:', err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('Something went wrong with the shuffle command — check the terminal.');
      } else {
        await interaction.reply({ content: 'Something went wrong — check the terminal.', flags: MessageFlags.Ephemeral });
      }
    } catch { /* best effort */ }
  }
});

// ============================================================
// 💨 High-Speed Connection — Staff Panel Button Handler
// Handles buttons posted in the staff panel channel
// ============================================================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('spdating:')) return;

  const guildId = interaction.guildId;
  const guild = interaction.guild;
  const cfg = ensureVcShuffleGuildConfig(guildId);

  // Only allow staff/admins to use these buttons
  const isStaff = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
    (cfg.staffRoleIds || []).some((id) => interaction.member?.roles?.cache?.has(id));
  if (!isStaff) {
    return interaction.reply({ content: '❌ These controls are for staff only.', flags: MessageFlags.Ephemeral });
  }

  const action = interaction.customId.split(':')[1];

  try {
    await interaction.deferUpdate(); // update the button message in place

    if (action === 'start') {
      if (!cfg.lobbyChannelIds.length) {
        return interaction.followUp({ content: '❌ No lobby channels configured — set them in the dashboard first.', flags: MessageFlags.Ephemeral });
      }
      await startVcShuffle(guild, guildId, true);
    }

    else if (action === 'bell') {
      const state = shuffleState.get(guildId);
      if (state?.warningTimeoutId) {
        clearTimeout(state.warningTimeoutId);
        if (state) state.warningTimeoutId = null;
      }
      await postBellMessage(guild, guildId);
      await runShuffleRound(guild, guildId);
      scheduleNextShuffle(guild, guildId);
    }

    else if (action === 'stop') {
      await stopVcShuffle(guild, guildId);
    }

    // refreshStaffPanel is already called inside start/stop/runShuffleRound,
    // but call it again here to make sure the button state updates immediately after deferUpdate
    await refreshStaffPanel(guild, guildId);

  } catch (err) {
    console.error('[vc-shuffle] Staff panel button error:', err);
    try {
      await interaction.followUp({ content: '❌ Something went wrong — check the terminal.', flags: MessageFlags.Ephemeral });
    } catch { /* best effort */ }
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
      const stillInMonitoredChannel = currentVoiceChannel && getEffectiveMonitoredChannelIds(guildId, member.guild).has(currentVoiceChannel.id);

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
          const stillIn = cvc && getEffectiveMonitoredChannelIds(guildId, member.guild).has(cvc.id);

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

  if (!channelId || !getEffectiveMonitoredChannelIds(guildId, newState.guild).has(channelId)) {
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
const FileStore = require('session-file-store')(session);
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
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: true, limit: '3mb' }));

app.use(
  session({
    store: new FileStore({
      path: dataPath('sessions'),
      ttl: 7 * 24 * 60 * 60, // 7 days in seconds
      retries: 1,
      logFn: () => {}, // silence file-store's own logs
    }),
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
    { path: '/vc-shuffle', label: 'VC Shuffle' },
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
      <h3>🔀 VC Shuffle</h3>
      ${(() => {
        const shuffleCfg = ensureVcShuffleGuildConfig(guildId);
        const shuffleStateVal = shuffleState.get(guildId);
        const poolSize = collectPoolMembers(guild, shuffleCfg).length;
        return `<p><span class="pill ${shuffleCfg.enabled ? 'on' : 'off'}">${shuffleCfg.enabled ? 'RUNNING' : 'STOPPED'}</span></p>
      <div class="stat-grid">
        <div class="stat"><div class="num">${shuffleStateVal?.roundNumber ?? 0}</div><div class="label">Rounds</div></div>
        <div class="stat"><div class="num">${poolSize}</div><div class="label">Pool size now</div></div>
        <div class="stat"><div class="num">${shuffleCfg.minIntervalMinutes}–${shuffleCfg.maxIntervalMinutes}m</div><div class="label">Interval</div></div>
        <div class="stat"><div class="num">${shuffleCfg.minGroupSize}–${shuffleCfg.maxGroupSize}</div><div class="label">Group size</div></div>
      </div>`;
      })()}
      <p style="margin-top:12px;"><a href="/vc-shuffle?guild=${guildId}">Configure →</a></p>
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
  const categories = [...guild.channels.cache.filter((c) => c.type === ChannelType.GuildCategory).values()].sort((a, b) => a.rawPosition - b.rawPosition);

  // Compute the effective monitored channel count (explicit + category-derived)
  const effectiveIds = getEffectiveMonitoredChannelIds(guild.id, guild);

  const channelChecklist =
    voiceChannels.map((c) => `<label class="check-item"><input type="checkbox" name="monitoredChannels" value="${c.id}" ${cfg.monitoredChannels.includes(c.id) ? 'checked' : ''}> #${escapeHtml(c.name)}</label>`).join('') ||
    '<p class="muted">No voice channels found.</p>';

  const categoryChecklist =
    categories.map((c) => `<label class="check-item"><input type="checkbox" name="monitoredCategoryIds" value="${c.id}" ${(cfg.monitoredCategoryIds || []).includes(c.id) ? 'checked' : ''}> 📁 ${escapeHtml(c.name)}</label>`).join('') ||
    '<p class="muted">No categories found.</p>';

  const roleChecklist =
    roles.map((r) => `<label class="check-item"><input type="checkbox" name="exemptRoles" value="${r.id}" ${cfg.exemptRoles.includes(r.id) ? 'checked' : ''}> ${escapeHtml(r.name)}</label>`).join('') ||
    '<p class="muted">No roles found.</p>';
  const announceOptions = textChannels.map((c) => `<option value="${c.id}" ${cfg.announcementChannelId === c.id ? 'selected' : ''}>#${escapeHtml(c.name)}</option>`).join('');

  const body = `
    <div class="card">
      <h2>📷 Camera Policy — ${escapeHtml(guild.name)}</h2>
      <p><span class="pill ${cfg.enabled ? 'on' : 'off'}">${cfg.enabled ? 'ENABLED' : 'DISABLED'}</span>
      ${cfg.announcementUrl ? ` · <a href="${cfg.announcementUrl}" target="_blank" rel="noopener">View posted announcement ↗</a>` : ''}</p>
      <p class="muted">Effectively monitoring <strong>${effectiveIds.size}</strong> voice channel(s) — ${cfg.monitoredChannels.length} explicit + ${effectiveIds.size - cfg.monitoredChannels.length} from categories.</p>
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
        <h3>Monitored Categories</h3>
        <p class="muted">All voice channels inside a checked category are monitored automatically. Stacks with the per-channel list below.</p>
        <div class="checklist">${categoryChecklist}</div>
        <h3 style="margin-top:16px;">Monitored Voice Channels</h3>
        <p class="muted">Individual channels to monitor regardless of category.</p>
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
  cfg.monitoredCategoryIds = asArray(req.body.monitoredCategoryIds);
  cfg.exemptRoles = asArray(req.body.exemptRoles);
  saveCameraConfig(cameraConfig);
  res.redirect(`/camera?guild=${guildId}&flash=${encodeURIComponent('Saved.')}`);
});

app.post('/camera/create-exempt-role', async (req, res) => {
  const guildId = req.body.guild;
  const guild = client.guilds.cache.get(guildId);
  const cfg = ensureGuildConfig(guildId);
  try {
    const role = await guild.roles.create({ name: 'Camera Policy Exempt', colors: [0x3498db], reason: 'Created via dashboard' });
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

    <div class="card" style="border-left: 3px solid var(--accent);">
      <h3>⚙️ How to set this up correctly</h3>
      <p class="muted" style="margin-bottom:10px;">For the activity tracker to work the way it's designed, your Discord server needs to be configured like this:</p>
      <ol style="color:var(--text-muted);padding-left:20px;line-height:2;">
        <li><strong style="color:var(--text-normal);">@everyone → no permissions</strong> — In Server Settings → Roles → @everyone, leave ALL permissions off. Don't check or X anything.</li>
        <li><strong style="color:var(--text-normal);">@everyone → View Channel ❌ on every category</strong> — In each category's settings, explicitly deny View Channel for @everyone so unverified people and inactive members can't see any channels by default.</li>
        <li><strong style="color:var(--text-normal);">Verified Member role → no server-level permissions</strong> — Leave the Verified Member role permissions blank in Server Settings → Roles. All access is granted per-channel, not server-wide.</li>
        <li><strong style="color:var(--text-normal);">Add Verified Member role to every channel you want verified users to see</strong> — Go into each channel → Permissions → add the Verified Member role with View Channel ✅ (and whatever else they need).</li>
        <li><strong style="color:var(--text-normal);">Set up the reactivation channel below</strong> — The bot will automatically give the Inactive role View Channel access to ONLY that one channel. Everything else stays invisible to inactive members.</li>
      </ol>
      <p class="muted" style="margin-top:8px;">When a member goes inactive: the bot removes their Verified Member role and adds the Inactive role — they instantly lose access to everything except the reactivation channel. When they reactivate: the bot removes the Inactive role and restores the Verified Member role, giving them full access again automatically.</p>
    </div>

    <div class="card">
      <form method="POST" action="/activity/save-roles">
        <input type="hidden" name="guild" value="${guildId}">
        <h3>Roles</h3>
        <div class="row">
          <div class="field"><label>Active role</label><select name="activeRoleId"><option value="">-- none --</option>${roleOptions(cfg.activeRoleId)}</select></div>
          <div class="field"><label>Inactive role</label><select name="inactiveRoleId"><option value="">-- none --</option>${roleOptions(cfg.inactiveRoleId)}</select></div>
        </div>
        <div class="field" style="margin-top:12px;">
          <label>Verified Member role <span class="muted">— only members with this role will be tracked for activity. Leave blank to track everyone.</span></label>
          <select name="verifiedRoleId"><option value="">-- track everyone --</option>${roleOptions(cfg.verifiedRoleId)}</select>
        </div>
        <h3>Exempt roles</h3>
        <div class="checklist">${exemptChecklist}</div>
        <div class="btn-row"><button type="submit">Save Roles</button></div>
      </form>
      <div class="btn-row">
        <form method="POST" action="/activity/create-role"><input type="hidden" name="guild" value="${guildId}"><input type="hidden" name="type" value="active"><button class="secondary" type="submit">Create Active Role</button></form>
        <form method="POST" action="/activity/create-role"><input type="hidden" name="guild" value="${guildId}"><input type="hidden" name="type" value="inactive"><button class="secondary" type="submit">Create Inactive Role</button></form>
        <form method="POST" action="/activity/create-role"><input type="hidden" name="guild" value="${guildId}"><input type="hidden" name="type" value="exempt"><button class="secondary" type="submit">Create Exempt Role</button></form>
        <form method="POST" action="/activity/create-role"><input type="hidden" name="guild" value="${guildId}"><input type="hidden" name="type" value="verified"><button class="secondary" type="submit">Create Verified Member Role</button></form>
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
  cfg.verifiedRoleId = req.body.verifiedRoleId || null;
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
    active:   { name: 'Active Member',            colors: [0x00cc66] },
    inactive: { name: 'Inactive Member',           colors: [0x999999] },
    exempt:   { name: 'Activity Tracker Exempt',   colors: [0x3498db] },
    verified: { name: 'Verified Member',           colors: [0xe91e8c] },
  };
  const spec = roleSpecs[req.body.type];
  if (!spec) return res.redirect(`/activity?guild=${guildId}`);
  try {
    const role = await guild.roles.create({ name: spec.name, colors: spec.colors, reason: 'Created via dashboard' });
    if (req.body.type === 'active') cfg.activeRoleId = role.id;
    else if (req.body.type === 'inactive') cfg.inactiveRoleId = role.id;
    else if (req.body.type === 'verified') cfg.verifiedRoleId = role.id;
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

// ---- 💨 High-Speed Connection Dashboard ----
app.get('/vc-shuffle', (req, res) => {
  const guildId = resolveGuildId(req);
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return res.redirect('/');
  const cfg = ensureVcShuffleGuildConfig(guildId);
  const state = shuffleState.get(guildId);

  const voiceChannels = [...guild.channels.cache.filter((c) => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice).values()].sort((a, b) => a.rawPosition - b.rawPosition);
  const textChannels = [...guild.channels.cache.filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement).values()].sort((a, b) => a.rawPosition - b.rawPosition);
  const categories = [...guild.channels.cache.filter((c) => c.type === ChannelType.GuildCategory).values()].sort((a, b) => a.rawPosition - b.rawPosition);
  const roles = [...guild.roles.cache.filter((r) => !r.managed && r.id !== guild.id).values()].sort((a, b) => b.rawPosition - a.rawPosition);
  const allRoles = [...guild.roles.cache.values()].sort((a, b) => b.rawPosition - a.rawPosition);

  const nextIn = state?.nextShuffleAt ? new Date(state.nextShuffleAt).toLocaleString() : 'N/A';
  const poolSize = collectPoolMembers(guild, cfg).length;

  const lobbyChecklist = voiceChannels.map((c) =>
    `<label class="check-item"><input type="checkbox" name="lobbyChannelIds" value="${c.id}" ${cfg.lobbyChannelIds.includes(c.id) ? 'checked' : ''}> 🔊 ${escapeHtml(c.name)}</label>`
  ).join('') || '<p class="muted">No voice channels found.</p>';

  const categoryOptions = `<option value="">-- top-level (no category) --</option>` +
    categories.map((c) => `<option value="${c.id}" ${cfg.categoryId === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');

  const announceOptions = `<option value="">-- none --</option>` +
    textChannels.map((c) => `<option value="${c.id}" ${cfg.announcementChannelId === c.id ? 'selected' : ''}>#${escapeHtml(c.name)}</option>`).join('');

  const participantRoleOptions = `<option value="">-- none --</option>` +
    roles.map((r) => `<option value="${r.id}" ${cfg.participantRoleId === r.id ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('');

  const botRoleOptions = `<option value="">-- none --</option>` +
    allRoles.map((r) => `<option value="${r.id}" ${cfg.botRoleId === r.id ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('');

  const staffRoleChecklist = roles.map((r) =>
    `<label class="check-item"><input type="checkbox" name="staffRoleIds" value="${r.id}" ${(cfg.staffRoleIds || []).includes(r.id) ? 'checked' : ''}> ${escapeHtml(r.name)}</label>`
  ).join('') || '<p class="muted">No roles found.</p>';

  const groupModeLabel = cfg.minGroupSize === 1 ? '1-on-1' : `${cfg.minGroupSize}v${cfg.minGroupSize}`;

  const body = `
    <div class="card">
      <h2>💨 High-Speed Connection — ${escapeHtml(guild.name)}</h2>
      <p><span class="pill ${cfg.enabled ? 'on' : 'off'}">${cfg.enabled ? 'RUNNING' : 'STOPPED'}</span></p>
      <div class="stat-grid">
        <div class="stat"><div class="num">${state?.roundNumber ?? 0}</div><div class="label">Rounds completed</div></div>
        <div class="stat"><div class="num">${state?.pairHistory?.size ?? 0}</div><div class="label">Unique connections</div></div>
        <div class="stat"><div class="num">${poolSize}</div><div class="label">Members in lobby</div></div>
        <div class="stat"><div class="num">${cfg.createdChannelIds.length}</div><div class="label">Active rooms</div></div>
        <div class="stat"><div class="num">${cfg.minIntervalMinutes}m</div><div class="label">Round length</div></div>
        <div class="stat"><div class="num">${groupModeLabel}</div><div class="label">Mode</div></div>
      </div>
      ${cfg.enabled ? `<p class="muted">Next bell at: ${nextIn}</p>` : ''}
      <div class="btn-row">
        <form method="POST" action="/vc-shuffle/start"><input type="hidden" name="guild" value="${guildId}"><button type="submit" ${cfg.enabled ? 'disabled style="opacity:0.5;"' : ''}>▶️ Start</button></form>
        <form method="POST" action="/vc-shuffle/stop"><input type="hidden" name="guild" value="${guildId}"><button class="danger" type="submit" ${!cfg.enabled ? 'disabled style="opacity:0.5;"' : ''}>⏹️ End Session</button></form>
        <form method="POST" action="/vc-shuffle/shuffle-now"><input type="hidden" name="guild" value="${guildId}"><button class="secondary" type="submit">🔔 Ring Bell Now</button></form>
      </div>
    </div>

    <div class="card">
      <form method="POST" action="/vc-shuffle/save-settings">
        <input type="hidden" name="guild" value="${guildId}">
        <h3>Round Timing</h3>
        <p class="muted">Set both min and max to the same value for a fixed round length (recommended for 💨 high-speed connection).</p>
        <div class="row">
          <div class="field"><label>Round length — min (minutes)</label><input type="number" name="minIntervalMinutes" min="1" max="60" value="${cfg.minIntervalMinutes ?? 3}"></div>
          <div class="field"><label>Round length — max (minutes)</label><input type="number" name="maxIntervalMinutes" min="1" max="60" value="${cfg.maxIntervalMinutes ?? 3}"></div>
          <div class="field"><label>Warning before bell (seconds)</label><input type="number" name="warningSeconds" min="5" max="300" value="${cfg.warningSeconds ?? 30}"></div>
        </div>
        <h3>Pairing Mode</h3>
        <p class="muted">1 = 1-on-1 (classic 💨 high-speed connection). 2 = 2v2. 3 = 3v3. Set both min and max to the same number.</p>
        <div class="row">
          <div class="field"><label>Group size (min)</label><input type="number" name="minGroupSize" min="1" max="10" value="${cfg.minGroupSize ?? 1}"></div>
          <div class="field"><label>Group size (max)</label><input type="number" name="maxGroupSize" min="1" max="10" value="${cfg.maxGroupSize ?? 1}"></div>
        </div>
        <h3>Room Category</h3>
        <div class="field"><label>Create "High Speed Connection" rooms under</label><select name="categoryId">${categoryOptions}</select></div>
        <h3>Announcement Channel</h3>
        <div class="field"><label>Post round results &amp; bell messages here</label><select name="announcementChannelId">${announceOptions}</select></div>
        <div class="btn-row"><button type="submit">💾 Save Settings</button></div>
      </form>
    </div>

    <div class="card">
      <form method="POST" action="/vc-shuffle/save-roles">
        <input type="hidden" name="guild" value="${guildId}">
        <h3>Participant Role</h3>
        <p class="muted">Assigned to every member when they join a lobby. All temp "High Speed Connection" rooms are locked to this role (+ staff + bot). Members who leave mid-session keep the role until the session ends.</p>
        <div class="field"><label>Participant role</label><select name="participantRoleId">${participantRoleOptions}</select></div>
        <h3>Bot Role</h3>
        <p class="muted">The bot's own managed role — needs View, Connect, and Manage Channel/Roles perms in temp rooms to move people.</p>
        <div class="field"><label>Bot role</label><select name="botRoleId">${botRoleOptions}</select></div>
        <h3>Staff Roles</h3>
        <p class="muted">These roles always get full access (View, Connect, Speak, Move Members) in every temp room.</p>
        <div class="checklist">${staffRoleChecklist}</div>
        <div class="btn-row"><button type="submit">💾 Save Roles</button></div>
      </form>
    </div>

    <div class="card">
      <form method="POST" action="/vc-shuffle/save-lobbies">
        <input type="hidden" name="guild" value="${guildId}">
        <h3>Lobby Channels</h3>
        <p class="muted">Members waiting here are pooled and paired when the round starts. Joining mid-session earns them the participant role immediately.</p>
        <div class="checklist">${lobbyChecklist}</div>
        <div class="btn-row"><button type="submit">💾 Save Lobbies</button></div>
      </form>
    </div>

    <div class="card">
      <h3>🏗️ Set Up Event Channels</h3>
      <p class="muted">Creates the full channel structure in one click — a <strong>💨 High-Speed Connection</strong> category containing:</p>
      <ul style="margin:8px 0 12px 18px; color: var(--text-muted); font-size:0.9rem; line-height:1.8;">
        <li><strong>#high-speed-connection-info</strong> — member-facing read-only info post (how it works)</li>
        <li><strong>#high-speed-connection-matchups</strong> — round pairings + session summary (member-readable)</li>
        <li><strong>#high-speed-connection-control</strong> — staff-only panel with live ▶️ 🔔 ⏹️ buttons</li>
        <li><strong>💨 High-Speed Connection Lobby</strong> — voice lobby (only created if no lobby is configured yet)</li>
      </ul>
      <p class="muted" style="margin-bottom:12px;">
        ${cfg.eventCategoryId ? `✅ Category already exists — clicking again only creates any missing channels and refreshes the staff panel.` : `⚠️ No event category yet — this will create everything from scratch.`}
      </p>
      ${cfg.staffPanelChannelId ? `<p class="muted" style="margin-bottom:12px;">Staff panel: <strong>#${guild.channels.cache.get(cfg.staffPanelChannelId)?.name ?? cfg.staffPanelChannelId}</strong></p>` : ''}
      ${cfg.matchupsChannelId ? `<p class="muted" style="margin-bottom:12px;">Matchups channel: <strong>#${guild.channels.cache.get(cfg.matchupsChannelId)?.name ?? cfg.matchupsChannelId}</strong></p>` : ''}
      ${cfg.infoChannelId ? `<p class="muted" style="margin-bottom:4px;">Info channel: <strong>#${guild.channels.cache.get(cfg.infoChannelId)?.name ?? cfg.infoChannelId}</strong></p>` : ''}
      <p class="muted" style="font-size:0.8rem; margin-top:12px;">
        ℹ️ Set up <strong>Participant Role</strong>, <strong>Staff Roles</strong>, and <strong>Bot Role</strong> in the Roles card above <em>before</em> running setup — the channel permissions are built from those values.
      </p>
      <form method="POST" action="/vc-shuffle/setup-channels">
        <input type="hidden" name="guild" value="${guildId}">
        <div class="btn-row" style="margin-top:12px;">
          <button type="submit">🏗️ ${cfg.eventCategoryId ? 'Re-run Setup / Refresh Panel' : 'Create Event Channels'}</button>
        </div>
      </form>
    </div>
  `;

  res.send(renderLayout({ title: '💨 High-Speed Connection', guildId, currentPath: '/vc-shuffle', body, flash: req.query.flash }));
});

app.post('/vc-shuffle/save-settings', (req, res) => {
  const { guild: guildId, minIntervalMinutes, maxIntervalMinutes, minGroupSize, maxGroupSize, categoryId, announcementChannelId, warningSeconds } = req.body;
  if (!guildId) return res.redirect('/');
  const cfg = ensureVcShuffleGuildConfig(guildId);
  cfg.minIntervalMinutes = Math.max(1, parseInt(minIntervalMinutes, 10) || 3);
  cfg.maxIntervalMinutes = Math.max(cfg.minIntervalMinutes, parseInt(maxIntervalMinutes, 10) || 3);
  // Speed dating supports group size of 1 (1-on-1)
  cfg.minGroupSize = Math.max(1, parseInt(minGroupSize, 10) || 1);
  cfg.maxGroupSize = Math.max(cfg.minGroupSize, parseInt(maxGroupSize, 10) || 1);
  cfg.categoryId = categoryId || null;
  cfg.announcementChannelId = announcementChannelId || null;
  cfg.warningSeconds = Math.min(300, Math.max(5, parseInt(warningSeconds, 10) || 30));
  saveVcShuffleConfig(vcShuffleConfig);
  res.redirect(`/vc-shuffle?guild=${guildId}&flash=${encodeURIComponent('Speed dating settings saved!')}`);
});

app.post('/vc-shuffle/save-roles', (req, res) => {
  const { guild: guildId, participantRoleId, botRoleId, staffRoleIds } = req.body;
  if (!guildId) return res.redirect('/');
  const cfg = ensureVcShuffleGuildConfig(guildId);
  cfg.participantRoleId = participantRoleId || null;
  cfg.botRoleId = botRoleId || null;
  cfg.staffRoleIds = asArray(staffRoleIds);
  saveVcShuffleConfig(vcShuffleConfig);
  res.redirect(`/vc-shuffle?guild=${guildId}&flash=${encodeURIComponent('Role settings saved!')}`);
});

app.post('/vc-shuffle/save-lobbies', (req, res) => {
  const { guild: guildId, lobbyChannelIds } = req.body;
  if (!guildId) return res.redirect('/');
  const cfg = ensureVcShuffleGuildConfig(guildId);
  cfg.lobbyChannelIds = asArray(lobbyChannelIds);
  saveVcShuffleConfig(vcShuffleConfig);
  res.redirect(`/vc-shuffle?guild=${guildId}&flash=${encodeURIComponent('Lobby channels saved!')}`);
});

app.post('/vc-shuffle/setup-channels', async (req, res) => {
  const { guild: guildId } = req.body;
  if (!guildId) return res.redirect('/');
  const guild = client.guilds.cache.get(guildId);
  const cfg = ensureVcShuffleGuildConfig(guildId);
  const { PermissionFlagsBits: PF } = require('discord.js');

  // Create channel first (no overwrites), then apply them after.
  // This requires only ManageChannels for creation; ManageRoles only needed for the overwrite step.
  async function createThenOverwrite(createOpts, overwrites, reason) {
    const ch = await guild.channels.create({ ...createOpts, reason });
    if (overwrites?.length) {
      try { await ch.permissionOverwrites.set(overwrites, reason); }
      catch (err) { console.warn(`[vc-shuffle] Could not apply overwrites to ${ch.name}: ${err.message}`); }
    }
    return ch;
  }

  try {
    const PFB = PF;
    const botId = client.user.id;

    const botOverwrite    = { id: botId,    allow: [PFB.ViewChannel, PFB.SendMessages, PFB.ReadMessageHistory, PFB.ManageMessages, PFB.ManageChannels, PFB.Connect, PFB.MoveMembers] };
    const everyoneDeny    = { id: guild.id, deny:  [PFB.ViewChannel, PFB.Connect] };
    const everyoneReadOnly= { id: guild.id, deny:  [PFB.SendMessages, PFB.CreatePublicThreads], allow: [PFB.ViewChannel, PFB.ReadMessageHistory] };

    const staffOverwrites = (cfg.staffRoleIds || []).map((id) => ({
      id, allow: [PFB.ViewChannel, PFB.SendMessages, PFB.ReadMessageHistory, PFB.ManageMessages, PFB.Connect, PFB.Speak, PFB.MoveMembers],
    }));
    const participantVC   = cfg.participantRoleId
      ? [{ id: cfg.participantRoleId, allow: [PFB.ViewChannel, PFB.Connect, PFB.Speak, PFB.UseVAD, PFB.Stream] }]
      : [];
    const participantRead = cfg.participantRoleId
      ? [{ id: cfg.participantRoleId, allow: [PFB.ViewChannel, PFB.ReadMessageHistory] }]
      : [];

    // ── 1. Category ──────────────────────────────────────────────────────────
    let category = cfg.eventCategoryId ? guild.channels.cache.get(cfg.eventCategoryId) : null;
    if (!category) {
      category = await createThenOverwrite(
        { name: '💨・ʜɪɢʜ-sᴘᴇᴇᴅ・ᴄᴏɴɴᴇᴄᴛɪᴏɴ', type: ChannelType.GuildCategory },
        [everyoneDeny, botOverwrite, ...staffOverwrites],
        '💨 High-Speed Connection: first-time setup'
      );
      cfg.eventCategoryId = category.id;
      cfg.categoryId = category.id;
    }

    // ── 2. 💨・ɪɴꜰᴏ (member-read-only how-it-works) ─────────────────────────
    let infoCh = cfg.infoChannelId ? guild.channels.cache.get(cfg.infoChannelId) : null;
    if (!infoCh) {
      infoCh = await createThenOverwrite(
        { name: '💨・ɪɴꜰᴏ', type: ChannelType.GuildText, parent: category.id },
        [everyoneReadOnly, botOverwrite, ...staffOverwrites, ...participantRead],
        '💨 High-Speed Connection: info channel'
      );
      cfg.infoChannelId = infoCh.id;
    }

    // ── 3. 💨・ᴍᴀᴛᴄʜ-ᴜᴘs (round pairings, member-readable) ─────────────────
    let matchupsCh = cfg.matchupsChannelId ? guild.channels.cache.get(cfg.matchupsChannelId) : null;
    if (!matchupsCh) {
      matchupsCh = await createThenOverwrite(
        { name: '💨・ᴍᴀᴛᴄʜ-ᴜᴘs', type: ChannelType.GuildText, parent: category.id },
        [everyoneReadOnly, botOverwrite, ...staffOverwrites, ...participantRead],
        '💨 High-Speed Connection: matchups channel'
      );
      cfg.matchupsChannelId = matchupsCh.id;
      cfg.announcementChannelId = matchupsCh.id;
    }

    // ── 4. 💨・ᴍᴀsᴛᴇʀ・ᴘᴀɴᴇʟ (staff-only control channel) ─────────────────
    let panelCh = cfg.staffPanelChannelId ? guild.channels.cache.get(cfg.staffPanelChannelId) : null;
    if (!panelCh) {
      panelCh = await createThenOverwrite(
        { name: '💨・ᴍᴀsᴛᴇʀ・ᴘᴀɴᴇʟ', type: ChannelType.GuildText, parent: category.id },
        [everyoneDeny, botOverwrite, ...staffOverwrites],
        '💨 High-Speed Connection: staff master panel'
      );
      cfg.staffPanelChannelId = panelCh.id;
    }

    // ── 5. 💨・ᴄᴏɴɴᴇᴄᴛɪᴏɴ・ʟᴏʙʙʏ (VC lobby) ──────────────────────────────
    let lobbyCh = cfg.lobbyChannelIds?.[0] ? guild.channels.cache.get(cfg.lobbyChannelIds[0]) : null;
    if (!lobbyCh) {
      lobbyCh = await createThenOverwrite(
        { name: '💨・ᴄᴏɴɴᴇᴄᴛɪᴏɴ・ʟᴏʙʙʏ', type: ChannelType.GuildVoice, parent: category.id },
        [everyoneDeny, botOverwrite, ...staffOverwrites, ...participantVC],
        '💨 High-Speed Connection: lobby'
      );
      cfg.lobbyChannelIds = [lobbyCh.id];
    }

    // ── 6. Pre-create cloud rooms (persistent — never deleted between rounds) ─
    // We create up to 8 rooms now and reuse them each round via direct swap.
    const CLOUD_ROOM_COUNT = 8;
    if (!cfg.cloudRoomIds) cfg.cloudRoomIds = [];
    for (let i = cfg.cloudRoomIds.length; i < CLOUD_ROOM_COUNT; i++) {
      await new Promise((r) => setTimeout(r, 800)); // rate limit buffer
      const num = i + 1;
      const room = await createThenOverwrite(
        { name: `💨・ᴄʟᴏᴜᴅ・ʀᴏᴏᴍ・${num}`, type: ChannelType.GuildVoice, parent: category.id },
        // Rooms start hidden/locked — bot manages access per round
        [everyoneDeny, botOverwrite, ...staffOverwrites],
        `💨 High-Speed Connection: cloud room ${num}`
      );
      cfg.cloudRoomIds.push(room.id);
    }

    saveVcShuffleConfig(vcShuffleConfig);

    // ── 7. Post how-it-works embed in 💨・ɪɴꜰᴏ ────────────────────────────
    try {
      const existing = await infoCh.messages.fetch({ limit: 5 });
      if (!existing.some((m) => m.author.id === botId)) {
        const infoEmbed = new EmbedBuilder()
          .setColor(0x8a2be2)
          .setTitle('💨 High-Speed Connection — How It Works')
          .setDescription(
            `Welcome to **💨 High-Speed Connection** — speed dating, VC style!\n\n` +
            `**1. 🚪 Join the lobby**\nHop into <#${lobbyCh.id}>. You're automatically in the pool for the next round.\n\n` +
            `**2. 💘 Get matched**\nWhen the round starts you'll be moved directly into a private cloud room with your match. Say hi!\n\n` +
            `**3. 🔔 The bell rings**\nYou'll get a 30-second heads-up before the round ends, then everyone swaps rooms to meet someone new.\n\n` +
            `**4. 🚫 No repeats**\nThe bot remembers who you've already talked to and avoids rematching you until you've met everyone.\n\n` +
            `**5. 👥 Odd numbers**\nIf there's an odd person out, they join the smallest group as a trio instead of being left alone.\n\n` +
            `**6. 📋 Matchups**\nEach round's pairings are posted in <#${matchupsCh.id}> — click names to view profiles!`
          )
          .setFooter({ text: '💨 High-Speed Connection · Managed by G33KY Bot' })
          .setTimestamp();
        await infoCh.send({ embeds: [infoEmbed] });
      }
    } catch (err) { console.error(`[vc-shuffle] Could not post info embed:`, err.message); }

    // ── 8. Post staff master panel ────────────────────────────────────────
    cfg.staffPanelMessageId = null; // force fresh post
    saveVcShuffleConfig(vcShuffleConfig);
    await refreshStaffPanel(guild, guildId);

    res.redirect(`/vc-shuffle?guild=${guildId}&flash=${encodeURIComponent('✅ All channels created! Check 💨・ᴍᴀsᴛᴇʀ・ᴘᴀɴᴇʟ for the live control panel.')}`);
  } catch (err) {
    console.error('[vc-shuffle] setup-channels error:', err);
    res.redirect(`/vc-shuffle?guild=${guildId}&flash=${encodeURIComponent('Setup failed — ' + err.message)}`);
  }
});

app.post('/vc-shuffle/start', async (req, res) => {
  const { guild: guildId } = req.body;
  if (!guildId) return res.redirect('/');
  const guild = client.guilds.cache.get(guildId);
  const cfg = ensureVcShuffleGuildConfig(guildId);
  if (!cfg.lobbyChannelIds.length) {
    return res.redirect(`/vc-shuffle?guild=${guildId}&flash=${encodeURIComponent('Add at least one lobby channel first.')}`);
  }
  await startVcShuffle(guild, guildId, true);
  res.redirect(`/vc-shuffle?guild=${guildId}&flash=${encodeURIComponent('Shuffle started!')}`);
});

app.post('/vc-shuffle/stop', async (req, res) => {
  const { guild: guildId } = req.body;
  if (!guildId) return res.redirect('/');
  const guild = client.guilds.cache.get(guildId);
  await stopVcShuffle(guild, guildId);
  res.redirect(`/vc-shuffle?guild=${guildId}&flash=${encodeURIComponent('Shuffle stopped. Temp rooms cleaned up.')}`);
});

app.post('/vc-shuffle/shuffle-now', async (req, res) => {
  const { guild: guildId } = req.body;
  if (!guildId) return res.redirect('/');
  const guild = client.guilds.cache.get(guildId);
  // Cancel pending warning before manually ringing the bell
  const state = shuffleState.get(guildId);
  if (state?.warningTimeoutId) {
    clearTimeout(state.warningTimeoutId);
    if (state) state.warningTimeoutId = null;
  }
  await postBellMessage(guild, guildId);
  await runShuffleRound(guild, guildId);
  scheduleNextShuffle(guild, guildId); // reset the next round timer
  res.redirect(`/vc-shuffle?guild=${guildId}&flash=${encodeURIComponent('Bell rung! Round started and timer reset.')}`);
});

app.listen(PORT, () => {
  console.log(`Dashboard listening on port ${PORT}`);
});

client.login(TOKEN);
