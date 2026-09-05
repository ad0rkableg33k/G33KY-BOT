// HIGH-SPEED CONNECTION — Discord community management bot
// - Channel indexer + camera policy + High-Speed Connection VC events
// - OAuth2 dashboard (Discord login) — users see only their own guilds
// - Activity tracker REMOVED in this version

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || '.';
function dataPath(f) { return path.join(DATA_DIR, f); }

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log(`[startup] Data directory ready: ${path.resolve(DATA_DIR)}`);
} catch (err) {
  console.error(`[startup] Could not create DATA_DIR (${DATA_DIR}):`, err.message);
}

const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  PermissionFlagsBits, EmbedBuilder, ChannelType, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, RoleSelectMenuBuilder, ChannelSelectMenuBuilder,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
} = require('discord.js');

const TOKEN   = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
if (!TOKEN || !GUILD_ID) { console.error('Missing DISCORD_TOKEN or GUILD_ID'); process.exit(1); }

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ],
});

// ===========================================================================
//  CAMERA POLICY CONFIG
// ===========================================================================
const CAMERA_CONFIG_FILE     = dataPath('camera-config.json');
const DEFAULT_GRACE_MINUTES   = 2;
const DEFAULT_WARNING_MINUTES = 3;

function loadCameraConfig() {
  try { return JSON.parse(fs.readFileSync(CAMERA_CONFIG_FILE, 'utf-8')); }
  catch { return {}; }
}
function saveCameraConfig(config) {
  try {
    fs.writeFileSync(CAMERA_CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log(`[camera] Config saved to ${CAMERA_CONFIG_FILE}`);
    return true;
  } catch (err) {
    console.error(`[camera] FAILED to save config:`, err.message);
    return false;
  }
}

let cameraConfig = loadCameraConfig();
for (const [gid, cfg] of Object.entries(cameraConfig)) {
  console.log(`[startup] camera-config guild=${gid} enabled=${cfg.enabled} monitoredChannels=${cfg.monitoredChannels?.length ?? 0}`);
}
if (Object.keys(cameraConfig).length === 0) {
  console.warn(`[startup] camera-config.json is empty — is DATA_DIR=${DATA_DIR} correct and volume mounted?`);
}

function ensureGuildConfig(guildId) {
  if (!cameraConfig[guildId]) {
    cameraConfig[guildId] = {
      enabled: false,
      monitoredChannels: [],
      monitoredCategoryIds: [],
      exemptRoles: [],
      graceMinutes: DEFAULT_GRACE_MINUTES,
      warningMinutes: DEFAULT_WARNING_MINUTES,
      announcementUrl: null,
      announcementChannelId: null,
    };
  }
  const c = cameraConfig[guildId];
  if (c.announcementChannelId === undefined) c.announcementChannelId = null;
  if (c.monitoredCategoryIds  === undefined) c.monitoredCategoryIds  = [];
  return c;
}

function isCameraPolicyEnabled(guildId)      { return ensureGuildConfig(guildId).enabled !== false; }
function setCameraPolicyEnabled(guildId, en) { ensureGuildConfig(guildId).enabled = en; return saveCameraConfig(cameraConfig); }
function getExemptRoles(guildId)             { return ensureGuildConfig(guildId).exemptRoles; }
function getTiming(guildId) {
  const c = ensureGuildConfig(guildId);
  return { graceMinutes: c.graceMinutes ?? DEFAULT_GRACE_MINUTES, warningMinutes: c.warningMinutes ?? DEFAULT_WARNING_MINUTES };
}
function getAnnouncementUrl(guildId) { return ensureGuildConfig(guildId).announcementUrl || null; }

function getEffectiveMonitoredChannelIds(guildId, guild) {
  const cfg = ensureGuildConfig(guildId);
  const ids = new Set(cfg.monitoredChannels);
  if (guild && cfg.monitoredCategoryIds?.length) {
    for (const ch of guild.channels.cache.values()) {
      if (ch.parentId && cfg.monitoredCategoryIds.includes(ch.parentId) &&
          (ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice)) {
        ids.add(ch.id);
      }
    }
  }
  return ids;
}
// ===========================================================================
//  CAMERA ENFORCEMENT
// ===========================================================================
const warnedUsers = new Map();

function warnKey(guildId, userId) { return `${guildId}:${userId}`; }
function announcementLine(guildId) {
  const url = getAnnouncementUrl(guildId);
  return url ? `\n🔗 Policy details: <${url}>` : '';
}
function clearAllCameraWarningsForGuild(guildId) {
  for (const [key, info] of warnedUsers.entries()) {
    if (!key.startsWith(`${guildId}:`)) continue;
    if (info.graceTimeoutId) clearTimeout(info.graceTimeoutId);
    if (info.warnTimeoutId)  clearTimeout(info.warnTimeoutId);
    warnedUsers.delete(key);
  }
}

async function handleCameraOff(member, channel) {
  const guildId = member.guild.id;
  const key = warnKey(guildId, member.id);
  if (warnedUsers.has(key)) return;

  const { graceMinutes, warningMinutes } = getTiming(guildId);
  const graceMs = graceMinutes * 60 * 1000;
  const warnMs  = warningMinutes * 60 * 1000;

  const graceTimeoutId = setTimeout(async () => {
    try {
      if (!isCameraPolicyEnabled(guildId)) { warnedUsers.delete(key); return; }
      const cvc = member.voice?.channel;
      const stillIn = cvc && getEffectiveMonitoredChannelIds(guildId, member.guild).has(cvc.id);
      if (!stillIn || member.voice.selfVideo) { warnedUsers.delete(key); return; }
      await cvc.send(`<@${member.id}> 📷 Please enable your camera — you have **${warningMinutes} minute(s)** before you'll be moved out of ${cvc}.${announcementLine(guildId)}`);
      const warnTimeoutId = setTimeout(async () => {
        try {
          if (!isCameraPolicyEnabled(guildId)) { warnedUsers.delete(key); return; }
          const c2 = member.voice?.channel;
          const in2 = c2 && getEffectiveMonitoredChannelIds(guildId, member.guild).has(c2.id);
          if (in2 && !member.voice.selfVideo) {
            await member.voice.disconnect('Camera not enabled within warning period');
            await c2.send(`<@${member.id}> ❌ You were moved out for not enabling your camera. Feel free to rejoin anytime with it on!`);
          }
        } catch (err) { console.error('[camera] removal error:', err.message); }
        finally { warnedUsers.delete(key); }
      }, warnMs);
      warnedUsers.set(key, { stage: 'warned', warnTimeoutId, channel: cvc });
    } catch (err) { console.error('[camera] reminder error:', err.message); warnedUsers.delete(key); }
  }, graceMs);
  warnedUsers.set(key, { stage: 'grace', graceTimeoutId, channel });
}

async function clearWarning(guildId, userId, { confirm = true } = {}) {
  const key  = warnKey(guildId, userId);
  const info = warnedUsers.get(key);
  if (!info) return;
  if (info.graceTimeoutId) clearTimeout(info.graceTimeoutId);
  if (info.warnTimeoutId)  clearTimeout(info.warnTimeoutId);
  warnedUsers.delete(key);
  if (confirm && info.stage === 'warned' && info.channel) {
    try { await info.channel.send(`<@${userId}> ✅ Thanks for turning your camera on!`); }
    catch (err) { console.error('[camera] confirm send error:', err.message); }
  }
}

// ===========================================================================
//  CHANNEL INDEX CONFIG
// ===========================================================================
const CHANNEL_INDEX_CONFIG_FILE = dataPath('channel-index-config.json');
const CHANNEL_TYPE_NAMES = {
  [ChannelType.GuildText]: 'text', [ChannelType.GuildVoice]: 'voice',
  [ChannelType.GuildCategory]: 'category', [ChannelType.GuildAnnouncement]: 'announcement',
  [ChannelType.GuildForum]: 'forum', [ChannelType.GuildStageVoice]: 'stage',
  [ChannelType.GuildMedia]: 'media',
};

function loadChannelIndexConfig() {
  try { return JSON.parse(fs.readFileSync(CHANNEL_INDEX_CONFIG_FILE, 'utf-8')); }
  catch { return {}; }
}
function saveChannelIndexConfig(c) {
  try { fs.writeFileSync(CHANNEL_INDEX_CONFIG_FILE, JSON.stringify(c, null, 2)); return true; }
  catch (err) { console.error('[channel-index] save fail:', err.message); return false; }
}
let channelIndexConfig = loadChannelIndexConfig();

function ensureChannelIndexGuildConfig(guildId) {
  if (!channelIndexConfig[guildId]) {
    channelIndexConfig[guildId] = {
      excludedCategoryIds: [],
      excludedChannelIds: [],
      excludedNameKeywords: guildId === GUILD_ID ? ['ticket'] : [],
    };
    saveChannelIndexConfig(channelIndexConfig);
  }
  return channelIndexConfig[guildId];
}

function getChannelData(guild, categoryFilter = null) {
  return guild.channels.cache
    .filter(ch => ch.type !== ChannelType.GuildCategory)
    .filter(ch => !categoryFilter || ch.parent?.name?.toLowerCase() === categoryFilter.toLowerCase())
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map(ch => ({
      name: ch.name, id: ch.id,
      type: CHANNEL_TYPE_NAMES[ch.type] || 'unknown',
      category: ch.parent ? ch.parent.name : null,
      categoryId: ch.parentId || null,
      link: `https://discord.com/channels/${guild.id}/${ch.id}`,
      topic: ch.topic || null,
    }));
}

const CHANNELS_FILE = dataPath('channels.json');
function exportToFile(guild) {
  const data = getChannelData(guild);
  fs.writeFileSync(CHANNELS_FILE, JSON.stringify(data, null, 2));
  return data;
}

const DESCRIPTIONS_FILE = dataPath('descriptions.json');
function loadAllDescriptions() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(DESCRIPTIONS_FILE, 'utf-8')); }
  catch { return {}; }
  const isLegacyFlat = Object.values(raw).some(v => v && typeof v === 'object' && 'name' in v && 'description' in v);
  if (isLegacyFlat) {
    const migrated = { [GUILD_ID]: raw };
    try { fs.writeFileSync(DESCRIPTIONS_FILE, JSON.stringify(migrated, null, 2)); } catch {}
    return migrated;
  }
  return raw;
}
function saveAllDescriptions(all) {
  try { fs.writeFileSync(DESCRIPTIONS_FILE, JSON.stringify(all, null, 2)); return true; }
  catch (err) { console.error('[descriptions] save fail:', err.message); return false; }
}
function loadDescriptions(guildId) { return loadAllDescriptions()[guildId] || {}; }
function ensureDescriptionsFile(guild) {
  const all = loadAllDescriptions();
  if (all[guild.id]) return;
  const data = getChannelData(guild);
  const template = {};
  for (const ch of data) template[ch.id] = { name: ch.name, description: '' };
  all[guild.id] = template;
  saveAllDescriptions(all);
}
// ===========================================================================
//  VC SHUFFLE / HIGH-SPEED CONNECTION
// ===========================================================================
const VC_SHUFFLE_CONFIG_FILE = dataPath('speed-match-config.json');
function loadVcShuffleConfig() {
  try { return JSON.parse(fs.readFileSync(VC_SHUFFLE_CONFIG_FILE, 'utf-8')); }
  catch { return {}; }
}
function saveVcShuffleConfig(d) {
  try { fs.writeFileSync(VC_SHUFFLE_CONFIG_FILE, JSON.stringify(d, null, 2)); return true; }
  catch (err) { console.error('[speed-match] save fail:', err.message); return false; }
}
let vcShuffleConfig = loadVcShuffleConfig();

function ensureVcShuffleGuildConfig(guildId) {
  if (!vcShuffleConfig[guildId]) {
    vcShuffleConfig[guildId] = {
      enabled: false, lobbyChannelIds: [], categoryId: null,
      minGroupSize: 1, maxGroupSize: 1,
      minIntervalMinutes: 3, maxIntervalMinutes: 3,
      announcementChannelId: null, createdChannelIds: [],
      participantRoleId: null, staffRoleIds: [], botRoleId: null,
      warningSeconds: 30,
      eventCategoryId: null, matchupsChannelId: null,
      staffPanelChannelId: null, infoChannelId: null, staffPanelMessageId: null,
      cloudRoomIds: [],
      connectionMode: 'standard',
      pairingPools: [],
      holdingChannelId: null,
    };
    saveVcShuffleConfig(vcShuffleConfig);
  }
  const c = vcShuffleConfig[guildId];
  if (!c.announcementChannelId) c.announcementChannelId = null;
  if (!c.createdChannelIds) c.createdChannelIds = [];
  if (c.participantRoleId === undefined) c.participantRoleId = null;
  if (!c.staffRoleIds) c.staffRoleIds = [];
  if (c.botRoleId === undefined) c.botRoleId = null;
  if (c.warningSeconds === undefined) c.warningSeconds = 30;
  if (c.eventCategoryId === undefined) c.eventCategoryId = null;
  if (c.matchupsChannelId === undefined) c.matchupsChannelId = null;
  if (c.staffPanelChannelId === undefined) c.staffPanelChannelId = null;
  if (c.infoChannelId === undefined) c.infoChannelId = null;
  if (c.staffPanelMessageId === undefined) c.staffPanelMessageId = null;
  if (!c.cloudRoomIds) c.cloudRoomIds = [];
  c.cloudRoomIds = [...new Set(c.cloudRoomIds)];
  if (!c.connectionMode) c.connectionMode = 'standard';
  if (!c.pairingPools) c.pairingPools = [];
  if (c.holdingChannelId === undefined) c.holdingChannelId = null;
  return c;
}

// In-memory session state per guild
const shuffleState = new Map();
const roomButtonMessages = new Map();

const BELL_MESSAGES = [
  '🔔 **Time\'s up!** The bell rings — moving everyone to fresh connections...',
  '🔔 **Ding ding!** Round over — rotating to new conversations...',
  '🔔 **Bell\'s ringing!** Hope it was good. Shuffling you into something new...',
  '🔔 **Connection complete.** Time to meet someone new — rotating now...',
  '🔔 **Round over!** Wrapping up and moving on — see you on the flip side...',
];

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function pairKey(a, b) { return a < b ? `${a}:${b}` : `${b}:${a}`; }

function speedDatePair(members, groupSize, pairHistory, skipHistory) {
  const combined = new Set([...pairHistory, ...skipHistory]);
  if (groupSize >= 2) return splitIntoGroups(members, groupSize, groupSize);
  const pool = shuffleArray(members);
  const paired = new Set(); const groups = [];
  for (let i = 0; i < pool.length; i++) {
    if (paired.has(pool[i].id)) continue;
    let partner = null;
    for (let j = i + 1; j < pool.length; j++) {
      if (paired.has(pool[j].id)) continue;
      if (!combined.has(pairKey(pool[i].id, pool[j].id))) { partner = pool[j]; break; }
    }
    if (!partner) {
      for (let j = i + 1; j < pool.length; j++) {
        if (!paired.has(pool[j].id) && !skipHistory.has(pairKey(pool[i].id, pool[j].id))) { partner = pool[j]; break; }
      }
    }
    if (!partner) {
      for (let j = i + 1; j < pool.length; j++) {
        if (!paired.has(pool[j].id)) { partner = pool[j]; break; }
      }
    }
    if (partner) {
      paired.add(pool[i].id); paired.add(partner.id);
      groups.push([pool[i], partner]);
    }
  }
  const unpaired = pool.filter(m => !paired.has(m.id));
  if (unpaired.length && groups.length > 0) groups[groups.length - 1].push(...unpaired);
  else if (unpaired.length) groups.push(unpaired);
  return groups;
}

function roleBasedPair(members, pairingPools, pairHistory, skipHistory) {
  const buckets = {}; const memberPool = {};
  for (const pool of pairingPools) {
    buckets[pool.poolName] = [];
    for (const m of members) {
      if (pool.roleIds.some(rid => m.roles.cache.has(rid))) {
        buckets[pool.poolName].push(m); memberPool[m.id] = pool.poolName;
      }
    }
  }
  const unassigned = members.filter(m => !memberPool[m.id]);
  const groups = []; const paired = new Set();
  for (const pool of pairingPools) {
    if (pool.pairWith === 'self') {
      const poolMembers = shuffleArray(buckets[pool.poolName] || []).filter(m => !paired.has(m.id));
      for (let i = 0; i < poolMembers.length - 1; i += 2) {
        paired.add(poolMembers[i].id); paired.add(poolMembers[i+1].id);
        groups.push([poolMembers[i], poolMembers[i+1]]);
      }
      const leftover = poolMembers.filter(m => !paired.has(m.id));
      if (leftover.length && groups.length > 0) groups[groups.length - 1].push(...leftover);
    } else if (pool.pairWith === 'other' && pool.otherPoolName) {
      const aPool = shuffleArray((buckets[pool.poolName] || []).filter(m => !paired.has(m.id)));
      const bPool = shuffleArray((buckets[pool.otherPoolName] || []).filter(m => !paired.has(m.id)));
      const minLen = Math.min(aPool.length, bPool.length);
      for (let i = 0; i < minLen; i++) {
        paired.add(aPool[i].id); paired.add(bPool[i].id); groups.push([aPool[i], bPool[i]]);
      }
    }
  }
  const remaining = [...unassigned, ...members.filter(m => !paired.has(m.id))];
  if (remaining.length >= 2) groups.push(...speedDatePair(remaining, 1, pairHistory, skipHistory));
  else if (remaining.length === 1 && groups.length > 0) groups[groups.length - 1].push(remaining[0]);
  return groups;
}

function splitIntoGroups(members, minSize, maxSize) {
  const shuffled = shuffleArray(members); const groups = []; let i = 0;
  while (i < shuffled.length) {
    const remaining = shuffled.length - i;
    if (remaining <= maxSize) { groups.push(shuffled.slice(i)); break; }
    const size = Math.floor(Math.random() * (maxSize - minSize + 1)) + minSize;
    groups.push(shuffled.slice(i, i + size)); i += size;
  }
  return groups;
}

function recordPairs(group, pairHistory) {
  for (let i = 0; i < group.length; i++)
    for (let j = i + 1; j < group.length; j++)
      pairHistory.add(pairKey(group[i].id, group[j].id));
}

function collectPoolMembers(guild, cfg) {
  const members = []; const seen = new Set();
  for (const chId of cfg.lobbyChannelIds) {
    const ch = guild.channels.cache.get(chId);
    if (!ch) continue;
    for (const m of ch.members.values()) {
      if (m.user.bot || seen.has(m.id)) continue;
      seen.add(m.id); members.push(m);
    }
  }
  return members;
}

async function cleanupShuffleChannels(guild, cfg) {
  const toDelete = [...cfg.createdChannelIds];
  cfg.createdChannelIds = []; saveVcShuffleConfig(vcShuffleConfig);
  for (const id of toDelete) {
    try { const ch = guild.channels.cache.get(id); if (ch) await ch.delete('Speed Match session ended'); }
    catch (err) { console.error(`[speed-match] delete temp channel ${id}:`, err.message); }
  }
}

async function moveEveryoneToLobby(guild, cfg) {
  if (!cfg.lobbyChannelIds.length) return;
  const lobby = guild.channels.cache.get(cfg.lobbyChannelIds[0]);
  if (!lobby) return;
  for (const channelId of cfg.createdChannelIds) {
    const ch = guild.channels.cache.get(channelId);
    if (!ch) continue;
    for (const m of ch.members.values()) {
      try { await m.voice.setChannel(lobby, 'Speed Match: returning to lobby'); }
      catch (err) { console.error(`[speed-match] move to lobby:`, err.message); }
    }
  }
}

async function postRoomActionButtons(guild, guildId, roomCh, groupMembers) {
  try {
    const prevMsgId = roomButtonMessages.get(roomCh.id);
    if (prevMsgId) {
      try { const pm = await roomCh.messages.fetch(prevMsgId).catch(() => null); if (pm) await pm.delete(); } catch {}
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`hsc:matchagain:${roomCh.id}`).setLabel('🔁 Match Again').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`hsc:skip:${roomCh.id}`).setLabel('⏭️ Skip').setStyle(ButtonStyle.Danger),
    );
    const msg = await roomCh.send({
      content: `👋 **You've been matched!**\n🔁 **Match Again** — both must vote to be re-paired next round\n⏭️ **Skip** — moves you to holding silently; your match stays until the bell`,
      components: [row],
    });
    roomButtonMessages.set(roomCh.id, msg.id);
  } catch (err) { console.error(`[speed-match] postRoomActionButtons:`, err.message); }
}
async function runShuffleRound(guild, guildId) {
  const cfg = ensureVcShuffleGuildConfig(guildId);
  if (!cfg.enabled || !cfg.lobbyChannelIds.length) return;
  const state = shuffleState.get(guildId);
  if (!state) return;
  if (state.warningTimeoutId) { clearTimeout(state.warningTimeoutId); state.warningTimeoutId = null; }
  state.roundNumber = (state.roundNumber || 0) + 1;
  const round = state.roundNumber;
  if (!state.pairHistory)    state.pairHistory    = new Set();
  if (!state.skipHistory)    state.skipHistory    = new Set();
  if (!state.matchAgainVotes) state.matchAgainVotes = new Map();

  // Handle "Match Again" votes
  const confirmedRePairs = new Set(); const matchPairs = [];
  for (const [voterId, partnerId] of state.matchAgainVotes.entries()) {
    if (state.matchAgainVotes.get(partnerId) === voterId && !confirmedRePairs.has(voterId)) {
      confirmedRePairs.add(voterId); confirmedRePairs.add(partnerId);
      matchPairs.push([voterId, partnerId]);
    }
  }
  state.matchAgainVotes = new Map();
  console.log(`[speed-match] Guild ${guildId}: round #${round}, rePairs=${matchPairs.length}`);

  // Collect pool from lobby + cloud rooms
  const cloudRoomIds = cfg.cloudRoomIds || [];
  const allSourceIds = [...cfg.lobbyChannelIds, ...cloudRoomIds];
  const seen = new Set(); const pool = [];
  for (const chId of allSourceIds) {
    const ch = guild.channels.cache.get(chId);
    if (!ch) continue;
    for (const m of ch.members.values()) {
      if (m.user.bot || seen.has(m.id)) continue;
      seen.add(m.id); pool.push(m);
    }
  }

  const matchupTarget = cfg.matchupsChannelId || cfg.announcementChannelId;
  const matchupCh = matchupTarget ? guild.channels.cache.get(matchupTarget) : null;

  if (pool.length < 2) {
    console.log(`[speed-match] Guild ${guildId}: only ${pool.length} member(s) — skipping round`);
    if (matchupCh) {
      const msg = await matchupCh.send(`⚠️ Not enough people in the lobby for Round #${round} — waiting for more to join!`).catch(() => null);
      if (msg) setTimeout(() => msg.delete().catch(() => {}), 15000);
    }
    scheduleNextShuffle(guild, guildId); return;
  }

  // Assign participant role
  if (cfg.participantRoleId) {
    for (const m of pool) {
      if (!m.roles.cache.has(cfg.participantRoleId))
        await m.roles.add(cfg.participantRoleId, '💨 HSC: joined session').catch(() => {});
    }
  }

  const rePairedIds = new Set(matchPairs.flat());
  const remainingPool = pool.filter(m => !rePairedIds.has(m.id));

  let groups;
  if (cfg.connectionMode === 'role-based' && cfg.pairingPools.length > 0) {
    groups = roleBasedPair(remainingPool, cfg.pairingPools, state.pairHistory, state.skipHistory);
  } else {
    groups = speedDatePair(remainingPool, cfg.minGroupSize ?? 1, state.pairHistory, state.skipHistory);
  }
  for (const [aid, bid] of matchPairs) {
    const ma = pool.find(m => m.id === aid); const mb = pool.find(m => m.id === bid);
    if (ma && mb) groups.unshift([ma, mb]);
  }
  for (const group of groups) recordPairs(group, state.pairHistory);

  // Countdown on round 1
  if (round === 1 && matchupCh) {
    for (const num of ['5️⃣', '4️⃣', '3️⃣', '2️⃣', '1️⃣']) {
      const m = await matchupCh.send(num).catch(() => null);
      await new Promise(r => setTimeout(r, 1000));
      if (m) m.delete().catch(() => {});
    }
    const go = await matchupCh.send('💨 **GO!**').catch(() => null);
    if (go) setTimeout(() => go.delete().catch(() => {}), 3000);
  }

  // Move into cloud rooms
  const activeRoomIds = [];
  for (let i = 0; i < groups.length; i++) {
    let roomCh = cloudRoomIds[i] ? guild.channels.cache.get(cloudRoomIds[i]) : null;
    if (!roomCh) {
      try {
        roomCh = await guild.channels.create({ name: `💨・ᴄʟᴏᴜᴅ・ʀᴏᴏᴍ・${i + 1}`, type: ChannelType.GuildVoice, parent: cfg.categoryId || null, reason: `💨 HSC round #${round} overflow` });
        if (!cfg.cloudRoomIds) cfg.cloudRoomIds = [];
        cfg.cloudRoomIds.push(roomCh.id);
      } catch (err) { console.error(`[speed-match] create overflow room:`, err.message); continue; }
    }
    activeRoomIds.push(roomCh.id);
    for (const m of groups[i])
      await roomCh.permissionOverwrites.edit(m, { ViewChannel: true, Connect: true, Speak: true }).catch(() => {});
    for (const m of groups[i])
      await m.voice.setChannel(roomCh, `💨 HSC round #${round}`).catch(err => console.error(`[speed-match] move ${m.id}:`, err.message));
    await postRoomActionButtons(guild, guildId, roomCh, groups[i]);
  }

  // Move anyone in unused cloud rooms back to lobby
  const lobby = guild.channels.cache.get(cfg.lobbyChannelIds[0]);
  for (let i = groups.length; i < cloudRoomIds.length; i++) {
    const roomCh = guild.channels.cache.get(cloudRoomIds[i]);
    if (!roomCh) continue;
    for (const m of roomCh.members.values()) {
      if (m.user.bot) continue;
      if (lobby) await m.voice.setChannel(lobby, '💨 Moved to lobby — room unused').catch(() => {});
    }
  }
  cfg.createdChannelIds = activeRoomIds;
  saveVcShuffleConfig(vcShuffleConfig);

  // Post matchups embed
  if (matchupCh) {
    try {
      const groupLines = groups.map((g, i) => {
        const names = g.map(m => `<@${m.id}>`).join(' ↔ ');
        const note = g.length > 2 ? ' *(trio)*' : (rePairedIds.has(g[0]?.id) ? ' *(rematched!)*' : '');
        return `💨・ᴄʟᴏᴜᴅ・ʀᴏᴏᴍ・${i + 1} — ${names}${note}`;
      }).join('\n');
      const allMet = pool.length > 1 && state.pairHistory.size >= (pool.length * (pool.length - 1)) / 2;
      const embed = new EmbedBuilder().setColor(0x8a2be2)
        .setTitle(`💨 Round #${round} Matchups`)
        .setDescription(`**${pool.length}** people · **${groups.length}** room${groups.length !== 1 ? 's' : ''}\n\n${groupLines}${allMet ? '\n\n🎉 Everyone\'s met everyone — resetting pair history!' : ''}`)
        .setFooter({ text: `~${cfg.minIntervalMinutes ?? 3} min per round · Use 🔁/⏭️ buttons in your room` })
        .setTimestamp();
      await matchupCh.send({ embeds: [embed] });
      if (allMet) { state.pairHistory = new Set(); state.skipHistory = new Set(); }
    } catch (err) { console.error(`[speed-match] post matchups:`, err.message); }
  }
  await refreshStaffPanel(guild, guildId);

  // Schedule warning
  const roundMs  = (cfg.minIntervalMinutes ?? 3) * 60 * 1000;
  const warnSecs = cfg.warningSeconds ?? 30;
  const warnMs   = Math.max(0, roundMs - warnSecs * 1000);
  const warningTimeoutId = warnMs > 0 ? setTimeout(async () => {
    const warnCh = matchupTarget ? guild.channels.cache.get(matchupTarget) : null;
    if (warnCh) {
      const wm = await warnCh.send(`⏰ **${warnSecs} seconds left!** Wrap it up — the bell rings soon! 🔔`).catch(() => null);
      if (wm) setTimeout(() => wm.delete().catch(() => {}), Math.max(0, (warnSecs - 3) * 1000));
    }
  }, warnMs) : null;
  const cur = shuffleState.get(guildId) || state;
  cur.warningTimeoutId = warningTimeoutId;
  shuffleState.set(guildId, cur);
  console.log(`[speed-match] Guild ${guildId}: round #${round} — ${pool.length} people in ${groups.length} rooms`);
}

function buildStaffPanelContent(guildId) {
  const cfg = ensureVcShuffleGuildConfig(guildId); const state = shuffleState.get(guildId);
  const running = cfg.enabled; const round = state?.roundNumber ?? 0;
  const pairs = state?.pairHistory?.size ?? 0;
  const nextAt = state?.nextShuffleAt ? `<t:${Math.floor(state.nextShuffleAt / 1000)}:R>` : '—';
  const mode = cfg.connectionMode === 'role-based' ? 'Role-Based' : ((cfg.minGroupSize ?? 1) === 1 ? '1-on-1' : `${cfg.minGroupSize}v${cfg.minGroupSize}`);
  const embed = new EmbedBuilder().setColor(running ? 0x8a2be2 : 0x555555)
    .setTitle('💨 High-Speed Connection — Master Panel')
    .setDescription('Live event controls. Use buttons below to manage the session.')
    .addFields(
      { name: 'Status', value: running ? '🟢 Running' : '🔴 Stopped', inline: true },
      { name: 'Round', value: String(round), inline: true },
      { name: 'Mode', value: mode, inline: true },
      { name: 'Round length', value: `${cfg.minIntervalMinutes ?? 3}m`, inline: true },
      { name: 'Next bell', value: running ? nextAt : '—', inline: true },
      { name: 'Unique pairs', value: String(pairs), inline: true },
    ).setFooter({ text: 'Auto-updates each round' }).setTimestamp();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('spdating:start').setLabel('▶️ Start').setStyle(ButtonStyle.Success).setDisabled(running),
    new ButtonBuilder().setCustomId('spdating:bell').setLabel('🔔 Next Round').setStyle(ButtonStyle.Primary).setDisabled(!running),
    new ButtonBuilder().setCustomId('spdating:stop').setLabel('⏹️ End Session').setStyle(ButtonStyle.Danger).setDisabled(!running),
  );
  return { embeds: [embed], components: [row] };
}

async function refreshStaffPanel(guild, guildId) {
  const cfg = ensureVcShuffleGuildConfig(guildId);
  if (!cfg.staffPanelChannelId) return;
  try {
    const ch = guild.channels.cache.get(cfg.staffPanelChannelId);
    if (!ch) return;
    const content = buildStaffPanelContent(guildId);
    if (cfg.staffPanelMessageId) {
      try { const msg = await ch.messages.fetch(cfg.staffPanelMessageId); await msg.edit(content); return; } catch {}
    }
    const msg = await ch.send(content);
    cfg.staffPanelMessageId = msg.id; saveVcShuffleConfig(vcShuffleConfig);
  } catch (err) { console.error(`[speed-match] refreshStaffPanel:`, err.message); }
}

async function postBellMessage(guild, guildId) {
  const cfg = ensureVcShuffleGuildConfig(guildId);
  const target = cfg.matchupsChannelId || cfg.announcementChannelId;
  if (!target) return;
  try {
    const ch = guild.channels.cache.get(target); if (!ch) return;
    const state = shuffleState.get(guildId);
    const msg = await ch.send(BELL_MESSAGES[(state?.roundNumber ?? 0) % BELL_MESSAGES.length]);
    setTimeout(() => msg.delete().catch(() => {}), 10000);
  } catch (err) { console.error(`[speed-match] postBellMessage:`, err.message); }
}

function randomIntervalMs(cfg) {
  const min = (cfg.minIntervalMinutes ?? 3) * 60 * 1000;
  const max = (cfg.maxIntervalMinutes ?? cfg.minIntervalMinutes ?? 3) * 60 * 1000;
  return Math.max(min, Math.floor(Math.random() * (max - min + 1)) + min);
}

function scheduleNextShuffle(guild, guildId) {
  const cfg = ensureVcShuffleGuildConfig(guildId); if (!cfg.enabled) return;
  const delay = randomIntervalMs(cfg); const nextAt = Date.now() + delay;
  const state = shuffleState.get(guildId) || {};
  if (state.timeoutId) clearTimeout(state.timeoutId);
  if (state.warningTimeoutId) clearTimeout(state.warningTimeoutId);
  const timeoutId = setTimeout(async () => {
    try { await postBellMessage(guild, guildId); await runShuffleRound(guild, guildId); }
    catch (err) { console.error(`[speed-match] round error ${guildId}:`, err.message); }
    const freshCfg = ensureVcShuffleGuildConfig(guildId);
    if (freshCfg.enabled) scheduleNextShuffle(guild, guildId);
    else shuffleState.delete(guildId);
  }, delay);
  shuffleState.set(guildId, { ...state, timeoutId, warningTimeoutId: null, nextShuffleAt: nextAt });
  console.log(`[speed-match] Guild ${guildId}: next round in ${Math.round(delay / 1000)}s`);
}

async function startVcShuffle(guild, guildId, runImmediately = false) {
  const cfg = ensureVcShuffleGuildConfig(guildId); cfg.enabled = true; saveVcShuffleConfig(vcShuffleConfig);
  const existing = shuffleState.get(guildId);
  if (existing?.timeoutId) clearTimeout(existing.timeoutId);
  if (existing?.warningTimeoutId) clearTimeout(existing.warningTimeoutId);
  shuffleState.set(guildId, { roundNumber: 0, pairHistory: new Set(), skipHistory: new Set(), matchAgainVotes: new Map() });
  if (runImmediately) await runShuffleRound(guild, guildId);
  scheduleNextShuffle(guild, guildId);
}

async function stopVcShuffle(guild, guildId) {
  const cfg = ensureVcShuffleGuildConfig(guildId); const state = shuffleState.get(guildId);
  cfg.enabled = false; saveVcShuffleConfig(vcShuffleConfig);
  if (state?.timeoutId) clearTimeout(state.timeoutId);
  if (state?.warningTimeoutId) clearTimeout(state.warningTimeoutId);
  await moveEveryoneToLobby(guild, cfg); await cleanupShuffleChannels(guild, cfg);
  if (cfg.participantRoleId) {
    for (const chId of cfg.lobbyChannelIds) {
      const ch = guild.channels.cache.get(chId); if (!ch) continue;
      for (const m of ch.members.values()) {
        try { if (m.roles.cache.has(cfg.participantRoleId)) await m.roles.remove(cfg.participantRoleId, '💨 HSC: session ended'); }
        catch (err) { console.error(`[speed-match] remove participant role:`, err.message); }
      }
    }
  }
  const summaryTarget = cfg.matchupsChannelId || cfg.announcementChannelId;
  if (summaryTarget && state?.pairHistory) {
    try {
      const textCh = guild.channels.cache.get(summaryTarget);
      if (textCh) {
        const embed = new EmbedBuilder().setColor(0x8a2be2).setTitle('💨 High-Speed Connection — Session Over')
          .setDescription(`That's a wrap!\n\n**Rounds completed:** ${state.roundNumber ?? 0}\n**Unique connections made:** ${state.pairHistory.size}\n\nEveryone has been returned to the lobby. Hope you made some good connections.`)
          .setTimestamp();
        await textCh.send({ embeds: [embed] });
      }
    } catch (err) { console.error(`[speed-match] session summary:`, err.message); }
  }
  shuffleState.delete(guildId); await refreshStaffPanel(guild, guildId);
}

// Re-arm on restart
client.once('clientReady', () => {
  for (const [guildId, cfg] of Object.entries(vcShuffleConfig)) {
    if (!cfg.enabled) continue;
    const guild = client.guilds.cache.get(guildId); if (!guild) continue;
    console.log(`[speed-match] Resuming for guild ${guildId}`);
    shuffleState.set(guildId, { roundNumber: 0, pairHistory: new Set(), skipHistory: new Set(), matchAgainVotes: new Map() });
    scheduleNextShuffle(guild, guildId);
  }
});
// ===========================================================================
//  VOICE STATE UPDATE — camera + participant role
// ===========================================================================
client.on('voiceStateUpdate', async (oldState, newState) => {
  const guildId = newState.guild.id; const userId = newState.id;
  const nowIn = !!newState.channelId;

  // Participant role auto-assign on lobby join
  if (nowIn && newState.member && !newState.member.user.bot) {
    const sc = vcShuffleConfig[guildId];
    if (sc?.enabled && sc.participantRoleId && sc.lobbyChannelIds?.includes(newState.channelId)) {
      try {
        if (!newState.member.roles.cache.has(sc.participantRoleId))
          await newState.member.roles.add(sc.participantRoleId, '💨 HSC: joined lobby');
      } catch (err) { console.error(`[speed-match] participant role assign fail:`, err.message); }
    }
  }

  // Camera policy
  if (!isCameraPolicyEnabled(guildId)) return;
  const channelId = newState.channelId;
  if (!channelId || !getEffectiveMonitoredChannelIds(guildId, newState.guild).has(channelId)) {
    if (!newState.channelId) await clearWarning(guildId, userId, { confirm: false });
    return;
  }
  const member = newState.member; const channel = newState.channel;
  const key = warnKey(guildId, userId);
  if (warnedUsers.has(key)) warnedUsers.get(key).channel = channel;
  const isExempt = member.roles.cache.some(r => getExemptRoles(guildId).includes(r.id));
  if (isExempt) { await clearWarning(guildId, userId, { confirm: false }); return; }
  if (!newState.selfVideo) await handleCameraOff(member, channel);
  else await clearWarning(guildId, userId, { confirm: true });
});

// ===========================================================================
//  SETUP MENU (/setup command)
// ===========================================================================
function buildMainMenuMessage() {
  const embed = new EmbedBuilder().setColor(0x8a2be2).setTitle('⚙️ HIGH-SPEED CONNECTION BOT Configuration')
    .setDescription('Select a module to configure below. Everything saves instantly.');
  const moduleSelect = new StringSelectMenuBuilder().setCustomId('setup:main:select').setPlaceholder('Select a module to configure...')
    .addOptions(
      { label: 'Camera Policy',  description: 'Cameras-on voice channel policy',             value: 'camera',   emoji: '📷' },
      { label: 'Channel Index',  description: 'Exclusions & descriptions for /channel-index', value: 'chindex',  emoji: '#️⃣' },
    );
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(moduleSelect)] };
}

function buildCameraMenuMessage(guildId) {
  const cfg = ensureGuildConfig(guildId); const catCount = cfg.monitoredCategoryIds?.length ?? 0;
  const embed = new EmbedBuilder().setColor(0x2b2d31).setTitle('📷 Camera Policy Configuration')
    .setDescription(
      `**Status:** ${cfg.enabled ? '🟢 Enabled' : '🔴 Disabled'}\n` +
      `**Timing:** ${cfg.graceMinutes ?? DEFAULT_GRACE_MINUTES}m grace + ${cfg.warningMinutes ?? DEFAULT_WARNING_MINUTES}m warning\n` +
      `**Announcement:** ${cfg.announcementUrl ? `[view post](${cfg.announcementUrl})` : 'Not set'}\n` +
      `**Monitored Channels:** ${cfg.monitoredChannels.length ? cfg.monitoredChannels.map(id => `<#${id}>`).join(', ') : 'Not set'}\n` +
      `**Monitored Categories:** ${catCount ? cfg.monitoredCategoryIds.map(id => `<#${id}>`).join(', ') : 'Not set'}\n` +
      `**Exempt Roles:** ${cfg.exemptRoles.length ? cfg.exemptRoles.map(id => `<@&${id}>`).join(', ') : 'Not set'}`
    );
  const topRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:camera:toggle').setLabel(cfg.enabled ? 'Disable' : 'Enable').setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('setup:camera:timing').setLabel('Set Timing').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:camera:categories-menu').setLabel('🗂 Categories').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:main').setLabel('⬅ Back').setStyle(ButtonStyle.Secondary),
  );
  const channelSelect = new ChannelSelectMenuBuilder().setCustomId('setup:camera:channels:select').setPlaceholder('Select monitored voice channels...').setChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice).setMinValues(0).setMaxValues(25);
  if (cfg.monitoredChannels.length) channelSelect.setDefaultChannels(...cfg.monitoredChannels.slice(0, 25));
  const roleSelect = new RoleSelectMenuBuilder().setCustomId('setup:camera:exempt:select').setPlaceholder('Select exempt role(s)...').setMinValues(0).setMaxValues(25);
  if (cfg.exemptRoles.length) roleSelect.setDefaultRoles(...cfg.exemptRoles.slice(0, 25));
  return { embeds: [embed], components: [topRow, new ActionRowBuilder().addComponents(channelSelect), new ActionRowBuilder().addComponents(roleSelect)] };
}

function buildCameraCategoriesMenuMessage(guildId) {
  const cfg = ensureGuildConfig(guildId); const catCount = cfg.monitoredCategoryIds?.length ?? 0;
  const embed = new EmbedBuilder().setColor(0x2b2d31).setTitle('📷 Camera Policy — Monitored Categories')
    .setDescription(`Select categories below. Every voice channel inside will be monitored.\n\n**Currently monitored:** ${catCount ? cfg.monitoredCategoryIds.map(id => `<#${id}>`).join(', ') : 'None'}`);
  const backRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup:camera:menu').setLabel('⬅ Back to Camera Policy').setStyle(ButtonStyle.Secondary));
  const categorySelect = new ChannelSelectMenuBuilder().setCustomId('setup:camera:categories:select').setPlaceholder('Select monitored categories...').setChannelTypes(ChannelType.GuildCategory).setMinValues(0).setMaxValues(25);
  if (catCount) categorySelect.setDefaultChannels(...cfg.monitoredCategoryIds.slice(0, 25));
  return { embeds: [embed], components: [backRow, new ActionRowBuilder().addComponents(categorySelect)] };
}

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'setup')
      return interaction.reply({ ...buildMainMenuMessage(), flags: MessageFlags.Ephemeral });
    if (!interaction.customId?.startsWith('setup:')) return;
    if (!interaction.isButton() && !interaction.isRoleSelectMenu() && !interaction.isChannelSelectMenu() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;

    const guildId = interaction.guildId; const id = interaction.customId;
    if (id === 'setup:main') return interaction.update(buildMainMenuMessage());
    if (id === 'setup:main:select') {
      const choice = interaction.values[0];
      if (choice === 'camera') return interaction.update(buildCameraMenuMessage(guildId));
      return;
    }
    if (id === 'setup:camera:menu')            return interaction.update(buildCameraMenuMessage(guildId));
    if (id === 'setup:camera:categories-menu') return interaction.update(buildCameraCategoriesMenuMessage(guildId));
    if (id === 'setup:camera:toggle') {
      const cfg = ensureGuildConfig(guildId); cfg.enabled = !cfg.enabled;
      const saved = saveCameraConfig(cameraConfig);
      if (!cfg.enabled) clearAllCameraWarningsForGuild(guildId);
      await interaction.update(buildCameraMenuMessage(guildId));
      if (!saved) await interaction.followUp({ content: '⚠️ Save failed — check Fly.io logs for DATA_DIR write error.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (id === 'setup:camera:channels:select') {
      ensureGuildConfig(guildId).monitoredChannels = interaction.values;
      saveCameraConfig(cameraConfig); return interaction.update(buildCameraMenuMessage(guildId));
    }
    if (id === 'setup:camera:categories:select') {
      ensureGuildConfig(guildId).monitoredCategoryIds = interaction.values;
      saveCameraConfig(cameraConfig); return interaction.update(buildCameraCategoriesMenuMessage(guildId));
    }
    if (id === 'setup:camera:exempt:select') {
      ensureGuildConfig(guildId).exemptRoles = interaction.values;
      saveCameraConfig(cameraConfig); return interaction.update(buildCameraMenuMessage(guildId));
    }
    if (id === 'setup:camera:timing') {
      const cfg = ensureGuildConfig(guildId);
      const modal = new ModalBuilder().setCustomId('setup:camera:timing:modal').setTitle('Camera Policy Timing');
      const graceInput   = new TextInputBuilder().setCustomId('grace').setLabel('Grace period (minutes, silent)').setStyle(TextInputStyle.Short).setValue(String(cfg.graceMinutes ?? DEFAULT_GRACE_MINUTES)).setRequired(true);
      const warningInput = new TextInputBuilder().setCustomId('warning').setLabel('Warning period (minutes, after reminder)').setStyle(TextInputStyle.Short).setValue(String(cfg.warningMinutes ?? DEFAULT_WARNING_MINUTES)).setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(graceInput), new ActionRowBuilder().addComponents(warningInput));
      return interaction.showModal(modal);
    }
    if (id === 'setup:camera:timing:modal') {
      const grace = parseInt(interaction.fields.getTextInputValue('grace'), 10);
      const warning = parseInt(interaction.fields.getTextInputValue('warning'), 10);
      if (!Number.isInteger(grace) || !Number.isInteger(warning) || grace < 0 || warning < 1)
        return interaction.reply({ content: '❌ Grace must be 0+ and warning must be 1+ (whole numbers).', flags: MessageFlags.Ephemeral });
      const cfg = ensureGuildConfig(guildId); cfg.graceMinutes = grace; cfg.warningMinutes = warning;
      saveCameraConfig(cameraConfig); return interaction.update(buildCameraMenuMessage(guildId));
    }
  } catch (err) {
    console.error('[setup] interaction error:', err);
    try {
      if (interaction.deferred || interaction.replied) await interaction.followUp({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral });
      else await interaction.reply({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral });
    } catch {}
  }
});

// ===========================================================================
//  HSC BUTTON HANDLER (Match Again / Skip + Staff Panel)
// ===========================================================================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  if (interaction.customId.startsWith('spdating:')) {
    const guildId = interaction.guildId; const guild = interaction.guild;
    const cfg = ensureVcShuffleGuildConfig(guildId);
    const isStaff = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
      (cfg.staffRoleIds || []).some(id => interaction.member?.roles?.cache?.has(id));
    if (!isStaff) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
    const action = interaction.customId.split(':')[1];
    try {
      await interaction.deferUpdate();
      if (action === 'start') {
        if (!cfg.lobbyChannelIds.length) return interaction.followUp({ content: '❌ No lobby channels configured.', flags: MessageFlags.Ephemeral });
        await startVcShuffle(guild, guildId, true);
      } else if (action === 'bell') {
        const state = shuffleState.get(guildId);
        if (state?.warningTimeoutId) { clearTimeout(state.warningTimeoutId); state.warningTimeoutId = null; }
        await postBellMessage(guild, guildId); await runShuffleRound(guild, guildId); scheduleNextShuffle(guild, guildId);
      } else if (action === 'stop') { await stopVcShuffle(guild, guildId); }
      await refreshStaffPanel(guild, guildId);
    } catch (err) {
      console.error('[spdating] button error:', err);
      try { await interaction.followUp({ content: '❌ Something went wrong.', flags: MessageFlags.Ephemeral }); } catch {}
    }
    return;
  }

  if (interaction.customId.startsWith('hsc:')) {
    const parts = interaction.customId.split(':'); const action = parts[1]; const roomId = parts[2];
    const guildId = interaction.guildId; const guild = interaction.guild;
    const userId = interaction.user.id; const state = shuffleState.get(guildId);
    if (!state) return interaction.reply({ content: '❌ No active session.', flags: MessageFlags.Ephemeral });
    const roomCh = guild.channels.cache.get(roomId);
    if (!roomCh) return interaction.reply({ content: '❌ Room not found.', flags: MessageFlags.Ephemeral });
    const roomMembers = [...roomCh.members.values()].filter(m => !m.user.bot);
    const partner = roomMembers.find(m => m.id !== userId);
    const cfg = ensureVcShuffleGuildConfig(guildId);

    if (action === 'matchagain') {
      if (!state.matchAgainVotes) state.matchAgainVotes = new Map();
      state.matchAgainVotes.set(userId, partner?.id || null);
      const partnerVoted = partner && state.matchAgainVotes.get(partner.id) === userId;
      if (partnerVoted) return interaction.reply({ content: '🎉 Both of you voted Match Again! You\'ll be paired together next round.', flags: MessageFlags.Ephemeral });
      return interaction.reply({ content: '🔁 Vote recorded! If your match also votes Match Again, you\'ll be re-paired next round.', flags: MessageFlags.Ephemeral });
    }
    if (action === 'skip') {
      if (partner) {
        if (!state.skipHistory) state.skipHistory = new Set();
        state.skipHistory.add(pairKey(userId, partner.id));
      }
      const holdingCh = cfg.holdingChannelId ? guild.channels.cache.get(cfg.holdingChannelId) : null;
      const lobbyCh = cfg.lobbyChannelIds?.[0] ? guild.channels.cache.get(cfg.lobbyChannelIds[0]) : null;
      const dest = holdingCh || lobbyCh;
      if (dest) {
        try {
          const skipper = guild.members.cache.get(userId);
          if (skipper?.voice?.channelId) await skipper.voice.setChannel(dest);
        } catch (err) { console.error('[hsc:skip] move skipper:', err.message); }
      }
      return interaction.reply({ content: '⏭️ You\'ve been moved to holding. Your match will rotate at the bell.', flags: MessageFlags.Ephemeral });
    }
  }

  if (interaction.customId.startsWith('purge:')) {
    const [, action, amountStr, userId] = interaction.customId.split(':');
    if (action === 'cancel') return interaction.update({ content: '❌ Purge cancelled.', embeds: [], components: [] });
    if (action === 'confirm') {
      const amount = parseInt(amountStr, 10);
      await interaction.update({ content: '🗑️ Deleting messages...', embeds: [], components: [] });
      try {
        let messages = await interaction.channel.messages.fetch({ limit: 100 });
        if (userId !== 'all') messages = messages.filter(m => m.author.id === userId);
        messages = [...messages.values()].slice(0, amount);
        const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
        const bulkable = messages.filter(m => m.createdTimestamp > twoWeeksAgo);
        const tooOld   = messages.filter(m => m.createdTimestamp <= twoWeeksAgo);
        let deleted = 0;
        if (bulkable.length >= 2) { await interaction.channel.bulkDelete(bulkable); deleted += bulkable.length; }
        else if (bulkable.length === 1) { await bulkable[0].delete(); deleted++; }
        for (const m of tooOld) { try { await m.delete(); deleted++; } catch {} }
        const warn = tooOld.length > 0 ? `\n⚠️ ${tooOld.length} message(s) older than 14 days deleted one-by-one.` : '';
        await interaction.editReply({ content: `✅ Deleted **${deleted}** message(s).${warn}` });
      } catch (err) {
        console.error('[purge] error:', err);
        await interaction.editReply({ content: `❌ Purge failed: ${err.message}` });
      }
    }
  }
});
// ===========================================================================
//  SLASH COMMANDS REGISTRATION
// ===========================================================================
const commands = [
  new SlashCommandBuilder().setName('setup').setDescription('Open the HIGH-SPEED CONNECTION BOT configuration menu').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('help').setDescription('Show all available HIGH-SPEED CONNECTION BOT commands'),
  new SlashCommandBuilder().setName('botinfo').setDescription('Show info about HIGH-SPEED CONNECTION BOT'),
  new SlashCommandBuilder().setName('serverinfo').setDescription('Show info about this server'),
  new SlashCommandBuilder().setName('channel-index').setDescription('Post a formatted index of all channels in this server')
    .addStringOption(opt => opt.setName('category').setDescription('Only list channels in this category (optional)').setRequired(false)),
  new SlashCommandBuilder().setName('export-channels').setDescription('Export all channels to a channels.json file'),
  new SlashCommandBuilder().setName('userinfo').setDescription('Show profile info for a user, even if they left the server')
    .addUserOption(opt => opt.setName('user').setDescription('The user to look up').setRequired(true)),
  new SlashCommandBuilder().setName('roleinfo').setDescription('Show info about a role')
    .addRoleOption(opt => opt.setName('role').setDescription('The role to look up').setRequired(true)),
  new SlashCommandBuilder().setName('purge').setDescription('Delete messages from this channel (requires Manage Messages)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption(opt => opt.setName('amount').setDescription('Number of messages to delete (1–100)').setRequired(true).setMinValue(1).setMaxValue(100))
    .addUserOption(opt => opt.setName('user').setDescription('Only delete messages from this user (optional)').setRequired(false)),
  new SlashCommandBuilder().setName('camera-policy').setDescription('Turn the cameras-on voice channel policy on or off')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(opt => opt.setName('state').setDescription('Turn the policy on or off').setRequired(true).addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' })),
  new SlashCommandBuilder().setName('camera-status').setDescription('View the full current camera policy configuration')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('camera-monitor').setDescription('Manage which voice channels enforce the cameras-on policy')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub.setName('add').setDescription('Start monitoring a voice channel').addChannelOption(opt => opt.setName('channel').setDescription('Voice channel').setRequired(true)))
    .addSubcommand(sub => sub.setName('remove').setDescription('Stop monitoring a voice channel').addChannelOption(opt => opt.setName('channel').setDescription('Voice channel').setRequired(true)))
    .addSubcommand(sub => sub.setName('list').setDescription('List all monitored voice channels')),
  new SlashCommandBuilder().setName('camera-exempt-role').setDescription('Manage roles exempt from the cameras-on policy')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub.setName('add').setDescription('Exempt a role').addRoleOption(opt => opt.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand(sub => sub.setName('remove').setDescription("Remove a role's exemption").addRoleOption(opt => opt.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand(sub => sub.setName('list').setDescription('List all exempt roles')),
  new SlashCommandBuilder().setName('camera-timing').setDescription('Configure camera policy timing')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub.setName('set').setDescription('Set the grace and warning period')
      .addIntegerOption(opt => opt.setName('grace_minutes').setDescription('Silent period before reminder (minutes)').setRequired(true).setMinValue(0).setMaxValue(60))
      .addIntegerOption(opt => opt.setName('warning_minutes').setDescription('Time after reminder before removal (minutes)').setRequired(true).setMinValue(1).setMaxValue(60)))
    .addSubcommand(sub => sub.setName('view').setDescription('View current timing settings')),
  new SlashCommandBuilder().setName('camera-announcement').setDescription('Set a link to your camera policy announcement')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub.setName('set').setDescription('Set the announcement link').addStringOption(opt => opt.setName('url').setDescription('Link to your policy post').setRequired(true)))
    .addSubcommand(sub => sub.setName('clear').setDescription('Remove the announcement link'))
    .addSubcommand(sub => sub.setName('view').setDescription('View the current announcement link')),
  new SlashCommandBuilder().setName('speed-match').setDescription('High-Speed Connection — VC speed match event')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub.setName('start').setDescription('Start the session (runs first round immediately)'))
    .addSubcommand(sub => sub.setName('stop').setDescription('Stop the session and clean up'))
    .addSubcommand(sub => sub.setName('status').setDescription('Show current shuffle configuration and state'))
    .addSubcommand(sub => sub.setName('set-group-size').setDescription('Set members per shuffle group')
      .addIntegerOption(opt => opt.setName('min').setDescription('Min group size').setRequired(true).setMinValue(1).setMaxValue(10))
      .addIntegerOption(opt => opt.setName('max').setDescription('Max group size').setRequired(true).setMinValue(1).setMaxValue(20)))
    .addSubcommand(sub => sub.setName('set-interval').setDescription('Set shuffle interval in minutes')
      .addIntegerOption(opt => opt.setName('min').setDescription('Min minutes').setRequired(true).setMinValue(1).setMaxValue(60))
      .addIntegerOption(opt => opt.setName('max').setDescription('Max minutes').setRequired(true).setMinValue(1).setMaxValue(60)))
    .addSubcommand(sub => sub.setName('add-lobby').setDescription('Add a lobby voice channel').addChannelOption(opt => opt.setName('channel').setDescription('Voice channel').setRequired(true)))
    .addSubcommand(sub => sub.setName('remove-lobby').setDescription('Remove a lobby voice channel').addChannelOption(opt => opt.setName('channel').setDescription('Voice channel').setRequired(true)))
    .addSubcommand(sub => sub.setName('set-category').setDescription('Set the category for temp rooms').addChannelOption(opt => opt.setName('category').setDescription('Category').setRequired(true)))
    .addSubcommand(sub => sub.setName('set-announce').setDescription('Set announcement text channel').addChannelOption(opt => opt.setName('channel').setDescription('Text channel').setRequired(true)))
    .addSubcommand(sub => sub.setName('shuffle-now').setDescription('Ring the bell and start a new round now'))
    .addSubcommand(sub => sub.setName('end-session').setDescription('End session and post summary'))
    .addSubcommand(sub => sub.setName('set-participant-role').setDescription('Role assigned when someone joins a lobby').addRoleOption(opt => opt.setName('role').setDescription('Participant role').setRequired(true)))
    .addSubcommand(sub => sub.setName('add-staff-role').setDescription('Add a staff role with access to temp rooms').addRoleOption(opt => opt.setName('role').setDescription('Staff role').setRequired(true)))
    .addSubcommand(sub => sub.setName('remove-staff-role').setDescription('Remove a staff role').addRoleOption(opt => opt.setName('role').setDescription('Staff role').setRequired(true)))
    .addSubcommand(sub => sub.setName('set-bot-role').setDescription("Set the bot's managed role").addRoleOption(opt => opt.setName('role').setDescription("Bot's role").setRequired(true)))
    .addSubcommand(sub => sub.setName('set-warning-seconds').setDescription('Seconds before bell to post warning').addIntegerOption(opt => opt.setName('seconds').setDescription('Seconds').setRequired(true).setMinValue(5).setMaxValue(300)))
    .addSubcommand(sub => sub.setName('set-connection-mode').setDescription('Set pairing mode: standard or role-based')
      .addStringOption(opt => opt.setName('mode').setDescription('Mode').setRequired(true)
        .addChoices({ name: 'Standard (1-on-1 anti-repeat)', value: 'standard' }, { name: 'Role-Based (pools)', value: 'role-based' })))
    .addSubcommand(sub => sub.setName('set-holding-channel').setDescription('VC where skipped members wait until the bell').addChannelOption(opt => opt.setName('channel').setDescription('Voice channel').setRequired(true))),
].map(cmd => cmd.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
  console.log('[startup] Slash commands registered globally.');
}
// ===========================================================================
//  MAIN SLASH COMMAND HANDLER
// ===========================================================================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    // /help
    if (interaction.commandName === 'help') {
      const embed = new EmbedBuilder().setColor(0x8a2be2).setTitle('⚙️ HIGH-SPEED CONNECTION BOT — Commands')
        .addFields(
          { name: '📋 General',              value: '`/help` `/botinfo` `/serverinfo` `/userinfo` `/roleinfo` `/purge`', inline: false },
          { name: '# Channel Index',         value: '`/channel-index` `/export-channels`', inline: false },
          { name: '📷 Camera Policy',        value: '`/camera-policy` `/camera-status` `/camera-monitor` `/camera-exempt-role` `/camera-timing` `/camera-announcement`', inline: false },
          { name: '💨 High-Speed Connection',value: '`/speed-match start/stop/status/shuffle-now/end-session`\n`/speed-match set-connection-mode` `/speed-match set-holding-channel` and more', inline: false },
          { name: '⚙️ Admin',                value: '`/setup` — interactive config menu', inline: false },
          { name: '📖 Dashboard',            value: 'high-speed-connection.fly.dev - log in with Discord', inline: false },
        ).setFooter({ text: 'HIGH-SPEED CONNECTION BOT · Made with 🖤' });
      return interaction.reply({ embeds: [embed] });
    }

    // /botinfo
    if (interaction.commandName === 'botinfo') {
      const guilds = client.guilds.cache.size;
      const uptime = process.uptime();
      const hours = Math.floor(uptime / 3600); const minutes = Math.floor((uptime % 3600) / 60);
      const embed = new EmbedBuilder().setColor(0x8a2be2).setTitle('⚙️ HIGH-SPEED CONNECTION BOT')
        .setThumbnail(client.user.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: 'Bot Tag',         value: client.user.tag,                                       inline: true },
          { name: 'Servers',         value: String(guilds),                                         inline: true },
          { name: 'Uptime',          value: `${hours}h ${minutes}m`,                               inline: true },
          { name: 'Dashboard',       value: 'high-speed-connection.fly.dev',          inline: false },
          { name: 'Terms of Service',value: 'high-speed-connection.fly.dev/tos',      inline: true },
          { name: 'Privacy Policy',  value: 'high-speed-connection.fly.dev/privacy',  inline: true },
        ).setFooter({ text: 'HIGH-SPEED CONNECTION BOT · Discord Community Management' }).setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    // /serverinfo
    if (interaction.commandName === 'serverinfo') {
      const guild = interaction.guild;
      await guild.members.fetch().catch(() => {});
      const bots  = guild.members.cache.filter(m => m.user.bot).size;
      const humans = guild.memberCount - bots;
      const channels = guild.channels.cache;
      const embed = new EmbedBuilder().setColor(0x8a2be2).setTitle(guild.name)
        .setThumbnail(guild.iconURL({ size: 256 }))
        .addFields(
          { name: 'Owner',        value: `<@${guild.ownerId}>`,                                                          inline: true },
          { name: 'Members',      value: `${humans} humans · ${bots} bots`,                                              inline: true },
          { name: 'Created',      value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`,                           inline: true },
          { name: 'Channels',     value: `${channels.filter(c => c.type === ChannelType.GuildText).size} text · ${channels.filter(c => c.type === ChannelType.GuildVoice).size} voice`, inline: true },
          { name: 'Roles',        value: String(guild.roles.cache.size),                                                  inline: true },
          { name: 'Boost Level',  value: `Level ${guild.premiumTier} (${guild.premiumSubscriptionCount} boosts)`,        inline: true },
          { name: 'Verification', value: guild.verificationLevel.toString(),                                              inline: true },
          { name: 'Server ID',    value: guild.id,                                                                        inline: true },
        );
      if (guild.bannerURL()) embed.setImage(guild.bannerURL({ size: 1024 }));
      return interaction.reply({ embeds: [embed] });
    }

    // /export-channels
    if (interaction.commandName === 'export-channels') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const data = exportToFile(interaction.guild);
      return interaction.editReply({ content: `Exported ${data.length} channels.`, files: [CHANNELS_FILE] });
    }

    // /userinfo
    if (interaction.commandName === 'userinfo') {
      await interaction.deferReply();
      const targetUser = interaction.options.getUser('user');
      const fullUser   = await client.users.fetch(targetUser.id, { force: true });
      let member = null;
      try { member = await interaction.guild.members.fetch(targetUser.id); } catch {}
      const embed = new EmbedBuilder()
        .setColor(member?.displayHexColor && member.displayHexColor !== '#000000' ? member.displayHexColor : 0x8a2be2)
        .setTitle(fullUser.username).setThumbnail(fullUser.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: 'User ID',        value: fullUser.id,                                              inline: true },
          { name: 'Display Name',   value: fullUser.globalName || fullUser.username,                  inline: true },
          { name: 'Bot Account',    value: fullUser.bot ? 'Yes' : 'No',                             inline: true },
          { name: 'Account Created',value: `<t:${Math.floor(fullUser.createdTimestamp / 1000)}:F>`, inline: false },
        ).setTimestamp();
      if (fullUser.banner) embed.setImage(fullUser.bannerURL({ size: 512 }));
      if (member) {
        embed.addFields(
          { name: 'In This Server', value: 'Yes',                                                   inline: true },
          { name: 'Nickname',       value: member.nickname || '—',                                   inline: true },
          { name: 'Joined Server',  value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:F>`,    inline: false },
        );
        const roles = member.roles.cache.filter(r => r.id !== interaction.guild.id).map(r => r.name);
        if (roles.length) embed.addFields({ name: `Roles (${roles.length})`, value: roles.join(', ').slice(0, 1024) });
      } else {
        embed.addFields({ name: 'In This Server', value: 'No — showing global profile only', inline: true });
      }
      return interaction.editReply({ embeds: [embed] });
    }

    // /roleinfo
    if (interaction.commandName === 'roleinfo') {
      const role = interaction.options.getRole('role');
      await interaction.guild.members.fetch().catch(() => {});
      const memberCount = interaction.guild.members.cache.filter(m => m.roles.cache.has(role.id) && !m.user.bot).size;
      const keyPerms = [
        ['Administrator',    PermissionFlagsBits.Administrator],
        ['Manage Guild',     PermissionFlagsBits.ManageGuild],
        ['Manage Roles',     PermissionFlagsBits.ManageRoles],
        ['Manage Channels',  PermissionFlagsBits.ManageChannels],
        ['Manage Messages',  PermissionFlagsBits.ManageMessages],
        ['Kick Members',     PermissionFlagsBits.KickMembers],
        ['Ban Members',      PermissionFlagsBits.BanMembers],
        ['Mention Everyone', PermissionFlagsBits.MentionEveryone],
        ['Mute Members',     PermissionFlagsBits.MuteMembers],
        ['Move Members',     PermissionFlagsBits.MoveMembers],
      ];
      const activePerms = keyPerms.filter(([, bit]) => role.permissions.has(bit)).map(([name]) => name);
      const embed = new EmbedBuilder().setColor(role.color || 0x8a2be2).setTitle(role.name)
        .addFields(
          { name: 'Role ID',          value: role.id,                                              inline: true },
          { name: 'Color',            value: role.hexColor,                                         inline: true },
          { name: 'Position',         value: String(role.position),                                 inline: true },
          { name: 'Members',          value: String(memberCount),                                   inline: true },
          { name: 'Mentionable',      value: role.mentionable ? 'Yes' : 'No',                      inline: true },
          { name: 'Hoisted',          value: role.hoist ? 'Yes (shown separately)' : 'No',         inline: true },
          { name: 'Managed',          value: role.managed ? 'Yes (bot/integration)' : 'No',        inline: true },
          { name: 'Created',          value: `<t:${Math.floor(role.createdTimestamp / 1000)}:D>`,  inline: true },
          { name: 'Key Permissions',  value: activePerms.length ? activePerms.join(', ') : 'None notable', inline: false },
        ).setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    // /purge — confirmation step
    if (interaction.commandName === 'purge') {
      const amount     = interaction.options.getInteger('amount');
      const userFilter = interaction.options.getUser('user');
      const confirmEmbed = new EmbedBuilder().setColor(0xff4d6d).setTitle('⚠️ Confirm Message Purge')
        .setDescription(
          `You are about to delete up to **${amount}** message(s) in <#${interaction.channel.id}>` +
          (userFilter ? ` from **${userFilter.tag}**` : '') +
          `.\n\nThis **cannot be undone**. Click Confirm to proceed.`
        );
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`purge:confirm:${amount}:${userFilter?.id || 'all'}`).setLabel('🗑️ Confirm Delete').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('purge:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      );
      return interaction.reply({ embeds: [confirmEmbed], components: [row], flags: MessageFlags.Ephemeral });
    }

    // /camera-policy
    if (interaction.commandName === 'camera-policy') {
      const enabled = interaction.options.getString('state') === 'on';
      const saved   = setCameraPolicyEnabled(interaction.guildId, enabled);
      if (!enabled) {
        for (const [key, info] of warnedUsers.entries()) {
          if (!key.startsWith(`${interaction.guildId}:`)) continue;
          if (info.graceTimeoutId) clearTimeout(info.graceTimeoutId);
          if (info.warnTimeoutId)  clearTimeout(info.warnTimeoutId);
          warnedUsers.delete(key);
        }
      }
      const saveWarning = saved ? '' : '\n⚠️ **Save failed** — check Fly.io logs for DATA_DIR write error.';
      return interaction.reply({ content: (enabled ? '📷 Camera policy is now **ON**.' : '📴 Camera policy is now **OFF**.') + saveWarning });
    }

    // /camera-status
    if (interaction.commandName === 'camera-status') {
      const cfg = ensureGuildConfig(interaction.guildId);
      const effectiveIds = getEffectiveMonitoredChannelIds(interaction.guildId, interaction.guild);
      const embed = new EmbedBuilder().setColor(cfg.enabled ? 0x00cc66 : 0x999999).setTitle('📷 Camera Policy Status')
        .addFields(
          { name: 'Enabled',         value: cfg.enabled ? 'Yes' : 'No',                                     inline: true },
          { name: 'Grace period',    value: `${cfg.graceMinutes ?? DEFAULT_GRACE_MINUTES}m`,                 inline: true },
          { name: 'Warning period',  value: `${cfg.warningMinutes ?? DEFAULT_WARNING_MINUTES}m`,             inline: true },
          { name: `Monitored channels (${effectiveIds.size} effective)`, value: cfg.monitoredChannels.length ? cfg.monitoredChannels.map(id => `<#${id}>`).join(', ') : 'None' },
          { name: `Monitored categories (${cfg.monitoredCategoryIds?.length ?? 0})`, value: cfg.monitoredCategoryIds?.length ? cfg.monitoredCategoryIds.map(id => `<#${id}>`).join(', ') : 'None' },
          { name: `Exempt roles (${cfg.exemptRoles.length})`, value: cfg.exemptRoles.length ? cfg.exemptRoles.map(id => `<@&${id}>`).join(', ') : 'None' },
          { name: 'Announcement link', value: cfg.announcementUrl || 'Not set' },
        );
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // /camera-monitor
    if (interaction.commandName === 'camera-monitor') {
      const sub = interaction.options.getSubcommand(); const gc = ensureGuildConfig(interaction.guildId);
      if (sub === 'add') {
        const ch = interaction.options.getChannel('channel');
        if (ch.type !== ChannelType.GuildVoice && ch.type !== ChannelType.GuildStageVoice) return interaction.reply({ content: '❌ Must be a voice channel.', flags: MessageFlags.Ephemeral });
        if (gc.monitoredChannels.includes(ch.id)) return interaction.reply({ content: `**#${ch.name}** is already monitored.`, flags: MessageFlags.Ephemeral });
        gc.monitoredChannels.push(ch.id); saveCameraConfig(cameraConfig);
        return interaction.reply(`✅ Now monitoring **#${ch.name}** for the cameras-on policy.`);
      }
      if (sub === 'remove') {
        const ch = interaction.options.getChannel('channel');
        if (!gc.monitoredChannels.includes(ch.id)) return interaction.reply({ content: `**#${ch.name}** wasn't monitored.`, flags: MessageFlags.Ephemeral });
        gc.monitoredChannels = gc.monitoredChannels.filter(id => id !== ch.id); saveCameraConfig(cameraConfig);
        return interaction.reply(`✅ Stopped monitoring **#${ch.name}**.`);
      }
      if (sub === 'list') {
        return interaction.reply({ content: `**Monitored voice channels:**\n${gc.monitoredChannels.length ? gc.monitoredChannels.map(id => `<#${id}>`).join('\n') : 'None'}`, flags: MessageFlags.Ephemeral });
      }
    }

    // /camera-exempt-role
    if (interaction.commandName === 'camera-exempt-role') {
      const sub = interaction.options.getSubcommand(); const gc = ensureGuildConfig(interaction.guildId);
      if (sub === 'add') {
        const role = interaction.options.getRole('role');
        if (gc.exemptRoles.includes(role.id)) return interaction.reply({ content: `**${role.name}** is already exempt.`, flags: MessageFlags.Ephemeral });
        gc.exemptRoles.push(role.id); saveCameraConfig(cameraConfig);
        return interaction.reply(`✅ **${role.name}** is now exempt from the cameras-on policy.`);
      }
      if (sub === 'remove') {
        const role = interaction.options.getRole('role');
        gc.exemptRoles = gc.exemptRoles.filter(id => id !== role.id); saveCameraConfig(cameraConfig);
        return interaction.reply(`✅ **${role.name}** is no longer exempt.`);
      }
      if (sub === 'list') {
        return interaction.reply({ content: `**Exempt roles:**\n${gc.exemptRoles.length ? gc.exemptRoles.map(id => `<@&${id}>`).join('\n') : 'None'}`, flags: MessageFlags.Ephemeral });
      }
    }

    // /camera-timing
    if (interaction.commandName === 'camera-timing') {
      const sub = interaction.options.getSubcommand(); const gc = ensureGuildConfig(interaction.guildId);
      if (sub === 'set') {
        gc.graceMinutes   = interaction.options.getInteger('grace_minutes');
        gc.warningMinutes = interaction.options.getInteger('warning_minutes');
        saveCameraConfig(cameraConfig);
        return interaction.reply(`✅ Timing updated: **${gc.graceMinutes}m** grace + **${gc.warningMinutes}m** warning = **${gc.graceMinutes + gc.warningMinutes}m** total before removal.`);
      }
      if (sub === 'view') {
        const { graceMinutes, warningMinutes } = getTiming(interaction.guildId);
        return interaction.reply({ content: `**Grace:** ${graceMinutes}m\n**Warning:** ${warningMinutes}m\n**Total:** ${graceMinutes + warningMinutes}m`, flags: MessageFlags.Ephemeral });
      }
    }

    // /camera-announcement
    if (interaction.commandName === 'camera-announcement') {
      const sub = interaction.options.getSubcommand(); const gc = ensureGuildConfig(interaction.guildId);
      if (sub === 'set') { gc.announcementUrl = interaction.options.getString('url'); saveCameraConfig(cameraConfig); return interaction.reply('✅ Announcement link set.'); }
      if (sub === 'clear') { gc.announcementUrl = null; saveCameraConfig(cameraConfig); return interaction.reply('✅ Announcement link cleared.'); }
      if (sub === 'view') { return interaction.reply({ content: gc.announcementUrl ? `Current link:\n${gc.announcementUrl}` : 'No link set.', flags: MessageFlags.Ephemeral }); }
    }

    // /channel-index
    if (interaction.commandName === 'channel-index') {
      await interaction.deferReply();
      const categoryFilter = interaction.options.getString('category');
      const data = getChannelData(interaction.guild, categoryFilter);
      const indexCfg = ensureChannelIndexGuildConfig(interaction.guildId);
      const descriptions = loadDescriptions(interaction.guildId);
      const byCategory = {};
      for (const ch of data) {
        if (ch.categoryId && indexCfg.excludedCategoryIds.includes(ch.categoryId)) continue;
        if (indexCfg.excludedChannelIds.includes(ch.id)) continue;
        const nameLower = ch.name.toLowerCase();
        if (indexCfg.excludedNameKeywords.some(kw => nameLower.includes(kw))) continue;
        const key = ch.category || 'No Category';
        if (!byCategory[key]) byCategory[key] = [];
        byCategory[key].push(ch);
      }
      const MAX_FIELDS = 25; const MAX_CHARS = 5500;
      const embeds = []; let current = null; let fieldCount = 0; let charCount = 0; let isFirst = true;
      const startNewEmbed = () => {
        const e = new EmbedBuilder().setColor(0x8a2be2);
        if (isFirst) { e.setTitle(categoryFilter ? `Channel Index — ${categoryFilter}` : 'Channel Index').setTimestamp(); isFirst = false; }
        return e;
      };
      current = startNewEmbed();
      for (const [category, chans] of Object.entries(byCategory)) {
        const lines = chans.map(ch => {
          const desc = descriptions[ch.id]?.description?.trim();
          return `[${desc ? `**#${ch.name}** — ${desc}` : `**#${ch.name}**`}](${ch.link})`;
        });
        const value = lines.join('\n').slice(0, 1024) || '—';
        if (fieldCount >= MAX_FIELDS || charCount + category.length + value.length > MAX_CHARS) {
          embeds.push(current); current = startNewEmbed(); fieldCount = 0; charCount = 0;
        }
        current.addFields({ name: category, value }); fieldCount++; charCount += category.length + value.length;
      }
      embeds.push(current);
      await interaction.editReply({ embeds: [embeds[0]] });
      for (let i = 1; i < embeds.length; i++) await interaction.followUp({ embeds: [embeds[i]] });
    }

    // /speed-match
    if (interaction.commandName === 'speed-match') {
      const sub = interaction.options.getSubcommand();
      const guild = interaction.guild; const cfg = ensureVcShuffleGuildConfig(interaction.guildId);

      if (sub === 'start') {
        if (!cfg.lobbyChannelIds.length) return interaction.reply({ content: '❌ Add a lobby channel first with `/speed-match add-lobby`.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply(); await startVcShuffle(guild, interaction.guildId, true);
        const state = shuffleState.get(interaction.guildId);
        const nextIn = state?.nextShuffleAt ? Math.round((state.nextShuffleAt - Date.now()) / 1000 / 60) : '?';
        return interaction.editReply(`🔀 **Session started!** First round complete. Next shuffle in ~${nextIn}m.`);
      }
      if (sub === 'stop' || sub === 'end-session') {
        await interaction.deferReply(); await stopVcShuffle(guild, interaction.guildId);
        return interaction.editReply('⏹️ **Session ended.** Everyone moved to lobby, summary posted.');
      }
      if (sub === 'shuffle-now') {
        await interaction.deferReply();
        const state = shuffleState.get(interaction.guildId);
        if (state?.warningTimeoutId) { clearTimeout(state.warningTimeoutId); state.warningTimeoutId = null; }
        await postBellMessage(guild, interaction.guildId);
        await runShuffleRound(guild, interaction.guildId);
        scheduleNextShuffle(guild, interaction.guildId);
        return interaction.editReply('🔔 **Bell rung!** Everyone moved. Timer reset.');
      }
      if (sub === 'status') {
        const state = shuffleState.get(interaction.guildId);
        const nextIn = state?.nextShuffleAt ? `<t:${Math.floor(state.nextShuffleAt / 1000)}:R>` : 'N/A';
        const modeLabel = cfg.connectionMode === 'role-based' ? 'Role-Based' : (cfg.minGroupSize === 1 ? '1-on-1' : `${cfg.minGroupSize}v${cfg.minGroupSize}`);
        const embed = new EmbedBuilder().setColor(cfg.enabled ? 0x8a2be2 : 0x999999).setTitle('💨 High-Speed Connection — Status')
          .addFields(
            { name: 'Running',          value: cfg.enabled ? '🟢 Yes' : '🔴 No',       inline: true },
            { name: 'Round #',          value: String(state?.roundNumber ?? 0),          inline: true },
            { name: 'Next bell',        value: cfg.enabled ? nextIn : 'Not scheduled',  inline: true },
            { name: 'Mode',             value: modeLabel,                                inline: true },
            { name: 'Round length',     value: `${cfg.minIntervalMinutes}m`,             inline: true },
            { name: 'Warn before bell', value: `${cfg.warningSeconds ?? 30}s`,           inline: true },
            { name: 'Unique pairs',     value: String(state?.pairHistory?.size ?? 0),    inline: true },
            { name: 'Unique skips',     value: String(state?.skipHistory?.size ?? 0),    inline: true },
            { name: 'Active rooms',     value: String(cfg.createdChannelIds.length),     inline: true },
            { name: 'Lobbies',          value: cfg.lobbyChannelIds.length ? cfg.lobbyChannelIds.map(id => `<#${id}>`).join(', ') : 'None', inline: false },
            { name: 'Holding channel',  value: cfg.holdingChannelId ? `<#${cfg.holdingChannelId}>` : 'Not set (falls back to lobby)', inline: false },
          );
        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }
      if (sub === 'set-group-size') {
        const min = interaction.options.getInteger('min'); const max = interaction.options.getInteger('max');
        if (min > max) return interaction.reply({ content: '❌ Min must be ≤ max.', flags: MessageFlags.Ephemeral });
        cfg.minGroupSize = min; cfg.maxGroupSize = max; saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ Group size set to **${min}–${max}** per room.`);
      }
      if (sub === 'set-interval') {
        const min = interaction.options.getInteger('min'); const max = interaction.options.getInteger('max');
        if (min > max) return interaction.reply({ content: '❌ Min must be ≤ max.', flags: MessageFlags.Ephemeral });
        cfg.minIntervalMinutes = min; cfg.maxIntervalMinutes = max; saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ Interval set to **${min}–${max}** minutes.`);
      }
      if (sub === 'add-lobby') {
        const ch = interaction.options.getChannel('channel');
        if (ch.type !== ChannelType.GuildVoice && ch.type !== ChannelType.GuildStageVoice) return interaction.reply({ content: '❌ Must be a voice channel.', flags: MessageFlags.Ephemeral });
        if (cfg.lobbyChannelIds.includes(ch.id)) return interaction.reply({ content: `**${ch.name}** is already a lobby.`, flags: MessageFlags.Ephemeral });
        cfg.lobbyChannelIds.push(ch.id); saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ **${ch.name}** added as a lobby channel.`);
      }
      if (sub === 'remove-lobby') {
        const ch = interaction.options.getChannel('channel');
        cfg.lobbyChannelIds = cfg.lobbyChannelIds.filter(id => id !== ch.id); saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ **${ch.name}** removed from lobby channels.`);
      }
      if (sub === 'set-category') {
        const ch = interaction.options.getChannel('category');
        if (ch.type !== ChannelType.GuildCategory) return interaction.reply({ content: '❌ Must be a category.', flags: MessageFlags.Ephemeral });
        cfg.categoryId = ch.id; saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ Temp rooms will be created inside **${ch.name}**.`);
      }
      if (sub === 'set-announce') {
        const ch = interaction.options.getChannel('channel');
        cfg.announcementChannelId = ch.id; saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ Announcements will post in <#${ch.id}>.`);
      }
      if (sub === 'set-participant-role') {
        cfg.participantRoleId = interaction.options.getRole('role').id; saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ **${interaction.options.getRole('role').name}** set as participant role.`);
      }
      if (sub === 'add-staff-role') {
        const role = interaction.options.getRole('role');
        if (!cfg.staffRoleIds) cfg.staffRoleIds = [];
        if (cfg.staffRoleIds.includes(role.id)) return interaction.reply({ content: `**${role.name}** is already a staff role.`, flags: MessageFlags.Ephemeral });
        cfg.staffRoleIds.push(role.id); saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ **${role.name}** added to staff roles.`);
      }
      if (sub === 'remove-staff-role') {
        const role = interaction.options.getRole('role');
        cfg.staffRoleIds = (cfg.staffRoleIds || []).filter(id => id !== role.id); saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ **${role.name}** removed from staff roles.`);
      }
      if (sub === 'set-bot-role') {
        cfg.botRoleId = interaction.options.getRole('role').id; saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ Bot role set to **${interaction.options.getRole('role').name}**.`);
      }
      if (sub === 'set-warning-seconds') {
        cfg.warningSeconds = interaction.options.getInteger('seconds'); saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ Warning fires **${cfg.warningSeconds}s** before the bell.`);
      }
      if (sub === 'set-connection-mode') {
        const mode = interaction.options.getString('mode');
        cfg.connectionMode = mode; saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ Connection mode set to **${mode === 'role-based' ? 'Role-Based' : 'Standard'}**. ${mode === 'role-based' ? 'Configure pairing pools in the dashboard.' : ''}`);
      }
      if (sub === 'set-holding-channel') {
        const ch = interaction.options.getChannel('channel');
        if (ch.type !== ChannelType.GuildVoice && ch.type !== ChannelType.GuildStageVoice) return interaction.reply({ content: '❌ Must be a voice channel.', flags: MessageFlags.Ephemeral });
        cfg.holdingChannelId = ch.id; saveVcShuffleConfig(vcShuffleConfig);
        return interaction.reply(`✅ Holding channel set to **${ch.name}**. Skipped members will wait here until the bell.`);
      }
    }

  } catch (err) {
    console.error('[command] error:', err);
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply('Something went wrong — check the terminal.');
      else await interaction.reply({ content: 'Something went wrong — check the terminal.', flags: MessageFlags.Ephemeral });
    } catch {}
  }
});

// ===========================================================================
//  STARTUP
// ===========================================================================
client.once('clientReady', async () => {
  console.log(`[startup] Logged in as ${client.user.tag}`);
  await registerCommands();
  const guild = await client.guilds.fetch(GUILD_ID);
  exportToFile(guild);
  ensureDescriptionsFile(guild);
});

client.on('error', err => console.error('[discord] client error:', err));
process.on('unhandledRejection', err => console.error('[process] unhandledRejection:', err));
// ===========================================================================

// Minimal HTTP server (health check only)
const PORT = process.env.PORT || 3000;
const express = require('express');
const app = express();
app.get('/health', (req, res) => res.status(200).send('ok'));
app.listen(PORT, () => { console.log(`[bot] Listening on port ${PORT}`); });
client.login(TOKEN);
