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
  new SlashCommandBuilder().setName('help').setDescription('Show all available G33KY Bot commands'),
  new SlashCommandBuilder().setName('botinfo').setDescription('Show info about G33KY Bot'),
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
          { name: '📖 Dashboard',            value: 'high-speed-connection.fly.dev — log in with Discord', inline: false },
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
//  WEB DASHBOARD — OAuth2 + Express
// ===========================================================================
const express  = require('express');
const session  = require('express-session');
const FileStore = require('session-file-store')(session);

const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DASHBOARD_URL         = process.env.DASHBOARD_URL || 'https://high-speed-connection.fly.dev';
const REDIRECT_URI          = `${DASHBOARD_URL}/auth/callback`;
const SESSION_SECRET        = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const PORT                  = process.env.PORT || 3000;

if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET)
  console.warn('[dashboard] DISCORD_CLIENT_ID or DISCORD_CLIENT_SECRET not set — OAuth login will fail.');
if (!process.env.SESSION_SECRET)
  console.warn('[dashboard] SESSION_SECRET not set — sessions reset on every restart.');

const app = express();
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: true, limit: '3mb' }));
const isProduction = !!process.env.FLY_APP_NAME || process.env.NODE_ENV === 'production';
app.use(session({
  store: new FileStore({ path: dataPath('sessions'), ttl: 7 * 24 * 60 * 60, retries: 1, logFn: () => {} }),
  secret: SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, secure: isProduction, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

async function exchangeCode(code) {
  const params = new URLSearchParams({ client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
  const res = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
  return res.json();
}
async function fetchDiscordUser(token)   { const r = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${token}` } }); return r.json(); }
async function fetchDiscordGuilds(token) { const r = await fetch('https://discord.com/api/users/@me/guilds', { headers: { Authorization: `Bearer ${token}` } }); return r.json(); }

function requireAuth(req, res, next) { if (req.session?.userId) return next(); return res.redirect('/login'); }
function asArray(val) { if (val === undefined) return []; return Array.isArray(val) ? val : [val]; }
function escapeHtml(str) { return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function resolveGuildId(req) {
  const requested = req.query.guild || req.body?.guild;
  const allowed   = req.session?.allowedGuildIds || [];
  if (requested && allowed.includes(requested) && client.guilds.cache.has(requested)) return requested;
  for (const id of allowed) { if (client.guilds.cache.has(id)) return id; }
  return null;
}

function renderLayout({ title, guildId, currentPath, body, flash, allowedGuildIds = [] }) {
  const guilds = [...client.guilds.cache.values()].filter(g => allowedGuildIds.includes(g.id));
  const guildOptions = guilds.map(g => `<option value="${g.id}" ${g.id === guildId ? 'selected' : ''}>${escapeHtml(g.name)}</option>`).join('');
  const navItems = [
    { path: '/',              label: 'Overview' },
    { path: '/camera',        label: 'Camera Policy' },
    { path: '/channel-index', label: 'Channel Index' },
    { path: '/speed-match',    label: 'Speed Match' },
    { path: '/tos',           label: 'Terms of Service' },
    { path: '/privacy',       label: 'Privacy Policy' },
  ];
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${escapeHtml(title)} — HIGH-SPEED CONNECTION DASHBOARD</title>
<style>
:root{--bg:#0d0d12;--panel:#17171f;--panel-border:#2a2a36;--accent:#b83df0;--accent-2:#ff2fb0;--text:#eaeaf2;--text-dim:#9a9aab;--green:#2ecc71;--red:#ff4d6d;}
*{box-sizing:border-box;}body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;min-height:100vh;}
a{color:var(--accent);text-decoration:none;}a:hover{text-decoration:underline;}code{background:#0d0d14;padding:1px 5px;border-radius:4px;font-size:12px;}
header{display:flex;align-items:center;justify-content:space-between;padding:14px 24px;background:linear-gradient(90deg,#1a0f24,#14141c);border-bottom:1px solid var(--panel-border);flex-wrap:wrap;gap:12px;}
header h1{font-size:18px;margin:0;background:linear-gradient(90deg,var(--accent),var(--accent-2));-webkit-background-clip:text;background-clip:text;color:transparent;}
nav{display:flex;gap:4px;flex-wrap:wrap;}
nav a{padding:8px 14px;border-radius:8px;color:var(--text-dim);font-size:14px;font-weight:500;}
nav a:hover{color:var(--text);text-decoration:none;background:var(--panel);}nav a.active{color:#fff;background:var(--accent);}
.topright{display:flex;align-items:center;gap:10px;}
select,input[type=text],input[type=number],input[type=password],textarea{background:#0d0d14;border:1px solid var(--panel-border);color:var(--text);border-radius:6px;padding:8px 10px;font-size:14px;font-family:inherit;}
main{padding:24px;max-width:1000px;margin:0 auto;}
.card{background:var(--panel);border:1px solid var(--panel-border);border-radius:12px;padding:20px;margin-bottom:20px;}
.card h2{margin-top:0;font-size:16px;}.card h3{font-size:13px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.04em;margin-bottom:10px;}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;}
.stat{background:#0d0d14;border:1px solid var(--panel-border);border-radius:10px;padding:14px;}
.stat .num{font-size:24px;font-weight:700;}.stat .label{font-size:12px;color:var(--text-dim);margin-top:2px;}
.pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;}
.pill.on{background:rgba(46,204,113,.15);color:var(--green);}.pill.off{background:rgba(255,77,109,.15);color:var(--red);}
form{margin:0;}.row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px;}
.field{display:flex;flex-direction:column;gap:6px;}.field label{font-size:12px;color:var(--text-dim);}
.checklist{max-height:220px;overflow-y:auto;background:#0d0d14;border:1px solid var(--panel-border);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:6px;}
.check-item{display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;}.check-item input{accent-color:var(--accent);}
button,.btn{background:var(--accent);color:#fff;border:none;border-radius:8px;padding:9px 16px;font-size:14px;font-weight:600;cursor:pointer;}
button:hover,.btn:hover{opacity:.9;}button.secondary{background:#2a2a36;}button.danger{background:var(--red);}
.btn-row{display:flex;gap:10px;flex-wrap:wrap;margin-top:10px;}
.flash{background:rgba(184,61,240,.15);border:1px solid var(--accent);padding:10px 14px;border-radius:8px;margin-bottom:16px;font-size:14px;}
table{width:100%;border-collapse:collapse;font-size:13px;}table th,table td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--panel-border);}
table input[type=text]{width:100%;}.muted{color:var(--text-dim);font-size:13px;}
.prose{line-height:1.75;color:var(--text);}.prose h2{font-size:1.1rem;margin-top:1.5rem;color:var(--accent);}
.prose h3{font-size:.95rem;margin-top:1.2rem;color:var(--accent-2);}.prose ul{padding-left:1.4rem;}.prose li{margin:.3rem 0;}
</style></head><body>
<header>
  <h1>⚙️ HIGH-SPEED CONNECTION BOT</h1>
  <nav>${navItems.map(n => `<a href="${n.path}?guild=${guildId || ''}" class="${n.path === currentPath ? 'active' : ''}">${n.label}</a>`).join('')}</nav>
  <div class="topright">
    ${guilds.length > 1 ? `<form method="GET" action="${currentPath}"><select name="guild" onchange="this.form.submit()">${guildOptions}</select></form>` : (guilds.length === 1 ? `<span style="color:var(--text-dim);font-size:14px;">${escapeHtml(guilds[0].name)}</span>` : '')}
    <a href="/logout" class="btn secondary" style="padding:8px 14px;">Log out</a>
  </div>
</header>
<main>${flash ? `<div class="flash">${escapeHtml(flash)}</div>` : ''}${body}</main>
</body></html>`;
}

// Auth routes
app.get('/login', (req, res) => {
  if (req.session?.userId) return res.redirect('/');
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  const params = new URLSearchParams({ client_id: DISCORD_CLIENT_ID || '', redirect_uri: REDIRECT_URI, response_type: 'code', scope: 'identify guilds', state });
  const authUrl = `https://discord.com/oauth2/authorize?${params}`;
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>LOGIN — HIGH-SPEED CONNECTION DASHBOARD</title>
  <style>body{margin:0;background:#0d0d12;color:#eaeaf2;font-family:-apple-system,sans-serif;}.wrap{display:flex;align-items:center;justify-content:center;min-height:100vh;}.card{background:#17171f;border:1px solid #2a2a36;border-radius:14px;padding:32px;width:320px;text-align:center;}h1{background:linear-gradient(90deg,#b83df0,#ff2fb0);-webkit-background-clip:text;background-clip:text;color:transparent;font-size:20px;}p{color:#9a9aab;font-size:14px;margin-bottom:20px;}a.btn{display:block;padding:12px;border-radius:8px;background:#5865F2;color:#fff;font-weight:600;font-size:15px;text-decoration:none;}a.btn:hover{opacity:.9;}</style></head><body>
  <div class="wrap"><div class="card"><h1>⚙️HIGH-SPEED CONNECTION BOT</h1><p>Log in with your Discord account to manage servers where you have administrator access.</p><a href="${authUrl}" class="btn">🔐 Log in with Discord</a></div></div>
  </body></html>`);
});

app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || state !== req.session.oauthState) return res.redirect('/login');
  try {
    const tokenData = await exchangeCode(code);
    if (!tokenData.access_token) return res.redirect('/login');
    const [user, guilds] = await Promise.all([fetchDiscordUser(tokenData.access_token), fetchDiscordGuilds(tokenData.access_token)]);
    const MANAGE_GUILD = 0x20;
    const allowedGuildIds = (guilds || [])
      .filter(g => (parseInt(g.permissions) & MANAGE_GUILD) === MANAGE_GUILD && client.guilds.cache.has(g.id))
      .map(g => g.id);
    req.session.userId = user.id; req.session.userTag = user.username;
    req.session.allowedGuildIds = allowedGuildIds; req.session.oauthState = null;
    req.session.save(err => {
      if (err) { console.error('[auth] session save error:', err); return res.redirect('/login'); }
      res.redirect('/');
    });
  } catch (err) { console.error('[auth] callback error:', err); res.redirect('/login'); }
});

app.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/login')); });
app.get('/health', (req, res) => res.status(200).send('ok'));
app.use(requireAuth);

// Overview
app.get('/', async (req, res) => {
  const guildId = resolveGuildId(req); const allowedGuildIds = req.session.allowedGuildIds || [];
  if (!guildId) return res.send(renderLayout({ title: 'Overview', guildId: null, currentPath: '/', allowedGuildIds, body: `<div class="card"><p>No servers found. Make sure the bot is installed in a server where you have Administrator.</p><p><a href="/login">Switch account</a></p></div>` }));
  const guild = client.guilds.cache.get(guildId);
  await guild.members.fetch().catch(() => {});
  const camCfg = ensureGuildConfig(guildId);
  const idxCfg = ensureChannelIndexGuildConfig(guildId);
  const shuffleCfg = ensureVcShuffleGuildConfig(guildId);
  const shuffleStateVal = shuffleState.get(guildId);
  const poolSize = collectPoolMembers(guild, shuffleCfg).length;
  const inGrace = [...warnedUsers.keys()].filter(k => k.startsWith(`${guildId}:`)).length;
  const totalChannels = guild.channels.cache.filter(c => c.type !== ChannelType.GuildCategory).size;
  const descriptions = loadDescriptions(guildId);
  const descFilled = Object.values(descriptions).filter(d => d.description?.trim()).length;
  const body = `
    <div class="card"><h2>${escapeHtml(guild.name)}</h2><div class="stat-grid">
      <div class="stat"><div class="num">${guild.memberCount}</div><div class="label">Members</div></div>
      <div class="stat"><div class="num">${totalChannels}</div><div class="label">Channels</div></div>
    </div></div>
    <div class="card"><h3>📷 Camera Policy</h3><p><span class="pill ${camCfg.enabled ? 'on' : 'off'}">${camCfg.enabled ? 'ENABLED' : 'DISABLED'}</span></p>
      <div class="stat-grid">
        <div class="stat"><div class="num">${camCfg.monitoredChannels.length}</div><div class="label">Monitored channels</div></div>
        <div class="stat"><div class="num">${camCfg.exemptRoles.length}</div><div class="label">Exempt roles</div></div>
        <div class="stat"><div class="num">${inGrace}</div><div class="label">In grace/warning now</div></div>
      </div><p style="margin-top:12px;"><a href="/camera?guild=${guildId}">Configure →</a></p></div>
    <div class="card"><h3># Channel Index</h3><div class="stat-grid">
      <div class="stat"><div class="num">${idxCfg.excludedCategoryIds.length}</div><div class="label">Excluded categories</div></div>
      <div class="stat"><div class="num">${idxCfg.excludedChannelIds.length}</div><div class="label">Excluded channels</div></div>
      <div class="stat"><div class="num">${descFilled}/${totalChannels}</div><div class="label">Descriptions filled</div></div>
    </div><p style="margin-top:12px;"><a href="/channel-index?guild=${guildId}">Configure →</a></p></div>
    <div class="card"><h3>💨 High-Speed Connection</h3><p><span class="pill ${shuffleCfg.enabled ? 'on' : 'off'}">${shuffleCfg.enabled ? 'RUNNING' : 'STOPPED'}</span></p>
      <div class="stat-grid">
        <div class="stat"><div class="num">${shuffleStateVal?.roundNumber ?? 0}</div><div class="label">Rounds</div></div>
        <div class="stat"><div class="num">${poolSize}</div><div class="label">In lobby now</div></div>
        <div class="stat"><div class="num">${shuffleCfg.minIntervalMinutes}m</div><div class="label">Round length</div></div>
        <div class="stat"><div class="num">${shuffleCfg.connectionMode === 'role-based' ? 'Role' : '1-on-1'}</div><div class="label">Mode</div></div>
      </div><p style="margin-top:12px;"><a href="/speed-match?guild=${guildId}">Configure →</a></p></div>`;
  res.send(renderLayout({ title: 'Overview', guildId, currentPath: '/', body, flash: req.query.flash, allowedGuildIds }));
});
// Camera Policy dashboard page
app.get('/camera', (req, res) => {
  const guildId = resolveGuildId(req); const allowedGuildIds = req.session.allowedGuildIds || [];
  const guild = client.guilds.cache.get(guildId); if (!guild) return res.redirect('/');
  const cfg = ensureGuildConfig(guildId);
  const voiceChannels = [...guild.channels.cache.filter(c => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice).values()].sort((a,b) => a.rawPosition - b.rawPosition);
  const textChannels  = [...guild.channels.cache.filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement).values()].sort((a,b) => a.rawPosition - b.rawPosition);
  const roles         = [...guild.roles.cache.filter(r => r.id !== guild.id).values()].sort((a,b) => b.position - a.position);
  const categories    = [...guild.channels.cache.filter(c => c.type === ChannelType.GuildCategory).values()].sort((a,b) => a.rawPosition - b.rawPosition);
  const effectiveIds  = getEffectiveMonitoredChannelIds(guildId, guild);
  const channelChecklist  = voiceChannels.map(c => `<label class="check-item"><input type="checkbox" name="monitoredChannels" value="${c.id}" ${cfg.monitoredChannels.includes(c.id) ? 'checked' : ''}> #${escapeHtml(c.name)}</label>`).join('') || '<p class="muted">No voice channels.</p>';
  const categoryChecklist = categories.map(c => `<label class="check-item"><input type="checkbox" name="monitoredCategoryIds" value="${c.id}" ${(cfg.monitoredCategoryIds || []).includes(c.id) ? 'checked' : ''}> 📁 ${escapeHtml(c.name)}</label>`).join('') || '<p class="muted">No categories.</p>';
  const roleChecklist     = roles.map(r => `<label class="check-item"><input type="checkbox" name="exemptRoles" value="${r.id}" ${cfg.exemptRoles.includes(r.id) ? 'checked' : ''}> ${escapeHtml(r.name)}</label>`).join('') || '<p class="muted">No roles.</p>';
  const announceOptions   = textChannels.map(c => `<option value="${c.id}" ${cfg.announcementChannelId === c.id ? 'selected' : ''}>#${escapeHtml(c.name)}</option>`).join('');
  const body = `
    <div class="card"><h2>📷 Camera Policy — ${escapeHtml(guild.name)}</h2>
      <p><span class="pill ${cfg.enabled ? 'on' : 'off'}">${cfg.enabled ? 'ENABLED' : 'DISABLED'}</span>
      ${cfg.announcementUrl ? ` · <a href="${cfg.announcementUrl}" target="_blank" rel="noopener">View posted announcement ↗</a>` : ''}</p>
      <p class="muted">Effectively monitoring <strong>${effectiveIds.size}</strong> channel(s) — ${cfg.monitoredChannels.length} explicit + ${effectiveIds.size - cfg.monitoredChannels.length} from categories.</p>
      <form method="POST" action="/camera/toggle"><input type="hidden" name="guild" value="${guildId}">
        <button class="${cfg.enabled ? 'danger' : ''}" type="submit">${cfg.enabled ? 'Disable Policy' : 'Enable Policy'}</button>
      </form></div>
    <div class="card"><form method="POST" action="/camera/save"><input type="hidden" name="guild" value="${guildId}">
      <h3>Timing</h3>
      <div class="row">
        <div class="field"><label>Grace period (minutes)</label><input type="number" name="graceMinutes" min="0" value="${cfg.graceMinutes ?? DEFAULT_GRACE_MINUTES}"></div>
        <div class="field"><label>Warning period (minutes)</label><input type="number" name="warningMinutes" min="1" value="${cfg.warningMinutes ?? DEFAULT_WARNING_MINUTES}"></div>
      </div>
      <h3>Monitored Categories</h3>
      <p class="muted">All voice channels inside a checked category are monitored automatically.</p>
      <div class="checklist">${categoryChecklist}</div>
      <h3 style="margin-top:16px;">Monitored Voice Channels</h3>
      <div class="checklist">${channelChecklist}</div>
      <h3 style="margin-top:16px;">Exempt Roles</h3>
      <div class="checklist">${roleChecklist}</div>
      <div class="btn-row"><button type="submit">Save Changes</button></div>
    </form></div>
    <div class="card"><h3>📢 Camera Policy Announcement</h3>
      <p class="muted"><strong>Attach an existing post</strong> — paste any Discord message link to use it as the policy reference in reminders without posting anything new.</p>
      ${cfg.announcementUrl ? `<p class="muted">Currently linked: <a href="${cfg.announcementUrl}" target="_blank">${cfg.announcementUrl}</a></p>` : ''}
      <form method="POST" action="/camera/set-announcement-url" style="margin-bottom:20px;"><input type="hidden" name="guild" value="${guildId}">
        <div class="field"><label>Discord message URL (paste existing post link)</label><input type="text" name="url" placeholder="https://discord.com/channels/..." value="${cfg.announcementUrl || ''}"></div>
        <div class="btn-row"><button type="submit" class="secondary">Use This Link</button>
        ${cfg.announcementUrl ? `<button type="submit" name="clear" value="1" class="danger">Clear Link</button>` : ''}</div>
      </form>
      <h3>Post a New Announcement</h3>
      <form method="POST" action="/camera/announce"><input type="hidden" name="guild" value="${guildId}">
        <div class="row"><div class="field" style="min-width:220px;"><label>Post to channel</label>
          <select name="channelId"><option value="">-- select a channel --</option>${announceOptions}</select></div></div>
        <div class="field"><label>Policy text</label>
          <textarea name="text" rows="5" style="width:100%;">Cameras must be ON while in monitored voice channels.\n\nIf your camera is off, you'll get a silent ${cfg.graceMinutes ?? DEFAULT_GRACE_MINUTES} minute grace period, then a reminder, then ${cfg.warningMinutes ?? DEFAULT_WARNING_MINUTES} more minute(s) before you're moved out of the channel. Turning your camera back on at any point cancels the timer.</textarea></div>
        <div class="btn-row"><button type="submit">Post New Announcement</button></div>
      </form></div>`;
  res.send(renderLayout({ title: 'Camera Policy', guildId, currentPath: '/camera', body, flash: req.query.flash, allowedGuildIds }));
});

app.post('/camera/toggle', (req, res) => {
  const guildId = req.body.guild; const cfg = ensureGuildConfig(guildId);
  cfg.enabled = !cfg.enabled; saveCameraConfig(cameraConfig);
  if (!cfg.enabled) clearAllCameraWarningsForGuild(guildId);
  res.redirect(`/camera?guild=${guildId}&flash=${encodeURIComponent(cfg.enabled ? 'Camera policy enabled.' : 'Camera policy disabled.')}`);
});
app.post('/camera/save', (req, res) => {
  const guildId = req.body.guild; const cfg = ensureGuildConfig(guildId);
  const grace = parseInt(req.body.graceMinutes, 10); const warning = parseInt(req.body.warningMinutes, 10);
  if (Number.isInteger(grace) && grace >= 0) cfg.graceMinutes = grace;
  if (Number.isInteger(warning) && warning >= 1) cfg.warningMinutes = warning;
  cfg.monitoredChannels    = asArray(req.body.monitoredChannels);
  cfg.monitoredCategoryIds = asArray(req.body.monitoredCategoryIds);
  cfg.exemptRoles          = asArray(req.body.exemptRoles);
  saveCameraConfig(cameraConfig);
  res.redirect(`/camera?guild=${guildId}&flash=${encodeURIComponent('Saved.')}`);
});
app.post('/camera/set-announcement-url', (req, res) => {
  const guildId = req.body.guild; const cfg = ensureGuildConfig(guildId);
  if (req.body.clear === '1') cfg.announcementUrl = null;
  else cfg.announcementUrl = req.body.url?.trim() || null;
  saveCameraConfig(cameraConfig);
  res.redirect(`/camera?guild=${guildId}&flash=${encodeURIComponent(req.body.clear === '1' ? 'Announcement link cleared.' : 'Announcement link updated.')}`);
});
app.post('/camera/announce', async (req, res) => {
  const guildId = req.body.guild; const guild = client.guilds.cache.get(guildId); const cfg = ensureGuildConfig(guildId);
  const { channelId, text } = req.body;
  if (!channelId || !text) return res.redirect(`/camera?guild=${guildId}&flash=${encodeURIComponent('Pick a channel and enter text first.')}`);
  try {
    const channel = await guild.channels.fetch(channelId);
    const embed = new EmbedBuilder().setColor(0x8a2be2).setTitle('📷 Camera Policy').setDescription(text).setTimestamp();
    const message = await channel.send({ embeds: [embed] });
    cfg.announcementChannelId = channelId;
    cfg.announcementUrl = `https://discord.com/channels/${guildId}/${channel.id}/${message.id}`;
    saveCameraConfig(cameraConfig);
    res.redirect(`/camera?guild=${guildId}&flash=${encodeURIComponent('Announcement posted and link saved.')}`);
  } catch (err) { res.redirect(`/camera?guild=${guildId}&flash=${encodeURIComponent('Failed to post — ' + err.message)}`); }
});

// Channel Index dashboard page
app.get('/channel-index', (req, res) => {
  const guildId = resolveGuildId(req); const allowedGuildIds = req.session.allowedGuildIds || [];
  const guild = client.guilds.cache.get(guildId); if (!guild) return res.redirect('/');
  const cfg = ensureChannelIndexGuildConfig(guildId);
  const categories  = [...guild.channels.cache.filter(c => c.type === ChannelType.GuildCategory).values()].sort((a,b) => a.rawPosition - b.rawPosition);
  const allChannels = getChannelData(guild);
  const descriptions = loadDescriptions(guildId);
  const categoryChecklist = categories.map(c => `<label class="check-item"><input type="checkbox" name="excludedCategoryIds" value="${c.id}" ${cfg.excludedCategoryIds.includes(c.id) ? 'checked' : ''}> ${escapeHtml(c.name)}</label>`).join('') || '<p class="muted">No categories.</p>';
  const channelChecklist  = allChannels.map(c => `<label class="check-item"><input type="checkbox" name="excludedChannelIds" value="${c.id}" ${cfg.excludedChannelIds.includes(c.id) ? 'checked' : ''}> #${escapeHtml(c.name)} ${c.category ? `<span class="muted">(${escapeHtml(c.category)})</span>` : ''}</label>`).join('') || '<p class="muted">No channels.</p>';
  const descRows = allChannels.map(c => `<tr><td>#${escapeHtml(c.name)}</td><td class="muted">${escapeHtml(c.category || '—')}</td><td><input type="text" name="desc_${c.id}" value="${escapeHtml(descriptions[c.id]?.description || '')}" placeholder="Optional blurb..."></td></tr>`).join('');
  const body = `
    <div class="card"><h2># Channel Index — ${escapeHtml(guild.name)}</h2><p class="muted">Controls what <code>/channel-index</code> shows.</p></div>
    <div class="card"><form method="POST" action="/channel-index/save-exclusions"><input type="hidden" name="guild" value="${guildId}">
      <h3>Excluded categories</h3><div class="checklist">${categoryChecklist}</div>
      <h3 style="margin-top:16px;">Excluded channels</h3><div class="checklist">${channelChecklist}</div>
      <h3 style="margin-top:16px;">Excluded name keywords</h3>
      <div class="field"><label>One per line — any channel containing these words is skipped</label>
      <textarea name="excludedNameKeywords" rows="3" style="width:100%;">${escapeHtml(cfg.excludedNameKeywords.join('\n'))}</textarea></div>
      <div class="btn-row"><button type="submit">Save Exclusions</button></div>
    </form></div>
    <div class="card"><h3>Channel descriptions</h3>
      <form method="POST" action="/channel-index/save-descriptions"><input type="hidden" name="guild" value="${guildId}">
        <table><thead><tr><th>Channel</th><th>Category</th><th>Description</th></tr></thead><tbody>${descRows}</tbody></table>
        <div class="btn-row"><button type="submit">Save Descriptions</button></div>
      </form></div>`;
  res.send(renderLayout({ title: 'Channel Index', guildId, currentPath: '/channel-index', body, flash: req.query.flash, allowedGuildIds }));
});
app.post('/channel-index/save-exclusions', (req, res) => {
  const guildId = req.body.guild; const cfg = ensureChannelIndexGuildConfig(guildId);
  cfg.excludedCategoryIds  = asArray(req.body.excludedCategoryIds);
  cfg.excludedChannelIds   = asArray(req.body.excludedChannelIds);
  cfg.excludedNameKeywords = String(req.body.excludedNameKeywords || '').split('\n').map(s => s.trim().toLowerCase()).filter(Boolean);
  saveChannelIndexConfig(channelIndexConfig);
  res.redirect(`/channel-index?guild=${guildId}&flash=${encodeURIComponent('Exclusions saved.')}`);
});
app.post('/channel-index/save-descriptions', (req, res) => {
  const guildId = req.body.guild; const guild = client.guilds.cache.get(guildId); if (!guild) return res.redirect('/');
  const allChannels = getChannelData(guild); const all = loadAllDescriptions(); const gd = all[guildId] || {};
  for (const c of allChannels) gd[c.id] = { name: c.name, description: (req.body[`desc_${c.id}`] || '').trim() };
  all[guildId] = gd; saveAllDescriptions(all);
  res.redirect(`/channel-index?guild=${guildId}&flash=${encodeURIComponent('Descriptions saved.')}`);
});

// TOS page
app.get('/tos', (req, res) => {
  const guildId = resolveGuildId(req); const allowedGuildIds = req.session.allowedGuildIds || [];
  const body = `<div class="card"><h2>HIGH-SPEED CONNECTION BOT — Terms of Service</h2>
    <p class="muted">Effective Date: August 8, 2026 · Last Updated: August 30, 2026</p>
    <div class="prose">
      <p>Welcome to <strong>HIGH-SPEED CONNECTION BOT</strong>. By adding, configuring, or using HIGH-SPEED CONNECTION BOT in a Discord server, you agree to these Terms of Service.</p>
      <h2>1. What HIGH-SPEED CONNECTION BOT Does</h2>
      <p>HIGH-SPEED CONNECTION BOT is a Discord community-management bot providing: voice-channel camera policy enforcement; camera reminders and configurable grace periods; channel indexing and server-management utilities; and High-Speed Connection voice events (speed-match style pairing, role-based modes).</p>
      <h2>2. Discord</h2>
      <p>HIGH-SPEED CONNECTION BOT operates through Discord and is dependent on Discord's services, APIs, and availability. Your use of Discord remains subject to Discord's own Terms of Service and Community Guidelines. HIGH-SPEED CONNECTION BOT is an independent third-party application not owned, operated, endorsed, or sponsored by Discord.</p>
      <h2>3. Server Administrator Responsibility</h2>
      <p>Server administrators are responsible for configuring the Bot appropriately; selecting monitored voice channels; configuring exempt roles; establishing appropriate server permissions; and informing server members about applicable server rules and policies. HIGH-SPEED CONNECTION BOT provides tools for enforcement — it does not determine what rules a server should have.</p>
      <h2>4. Camera Policy</h2>
      <p>When enabled by a server administrator, HIGH-SPEED CONNECTION BOT may monitor whether a member's camera is enabled in a designated voice channel. HIGH-SPEED CONNECTION BOT does <strong>not</strong> record, save, or transmit camera video — it uses Discord's voice-state information only.</p>
      <h2>5. High-Speed Connection Events</h2>
      <p>HIGH-SPEED CONNECTION BOT can run timed voice-channel pairing events. Session data (pair history, skip history) is stored in memory only and discarded when the session ends. No audio or video is recorded.</p>
      <h2>6. Acceptable Use</h2>
      <p>You agree not to use HIGH-SPEED CONNECTION BOT to violate applicable laws, harass or target individuals, circumvent Discord security or access controls, or attempt to interfere with the Bot's operation.</p>
      <h2>7. Availability</h2>
      <p>HIGH-SPEED CONNECTION BOT is provided on an "as is" and "as available" basis. We do not guarantee uninterrupted service, immediate command responses, or that data will never be lost.</p>
      <h2>8. Intellectual Property</h2>
      <p>HIGH-SPEED CONNECTION BOT, including its software, branding, and documentation, is owned by HIGH-SPEED CONNECTION BOT. You may not copy, redistribute, sell, sublicense, or commercially exploit HIGH-SPEED CONNECTION BOT without authorization.</p>
      <h2>9. Limitation of Liability</h2>
      <p>To the maximum extent permitted by applicable law, HIGH-SPEED CONNECTION BOT will not be liable for indirect, incidental, consequential, special, or punitive damages arising from use or inability to use the Bot.</p>
      <h2>10. Changes to These Terms</h2>
      <p>We may update these Terms from time to time. Updated Terms will be posted at <a href="/tos">high-speed-connection.fly.dev/tos</a>. Continued use constitutes acceptance.</p>
      <h2>11. Contact</h2>
      <p>Questions: <a href="mailto:dragon.exe@atomicmail.io">dragon.exe@atomicmail.io</a></p>
    </div></div>`;
  res.send(renderLayout({ title: 'Terms of Service', guildId, currentPath: '/tos', body, allowedGuildIds }));
});

// Privacy Policy page
app.get('/privacy', (req, res) => {
  const guildId = resolveGuildId(req); const allowedGuildIds = req.session.allowedGuildIds || [];
  const body = `<div class="card"><h2>HIGH-SPEED CONNECTION BOT — Privacy Policy</h2>
    <p class="muted">Effective Date: August 8, 2026 · Last Updated: August 30, 2026</p>
    <div class="prose">
      <p>This Privacy Policy explains how <strong>HIGH-SPEED CONNECTION BOT</strong> collects, uses, stores, and protects information when the Bot is used in a Discord server.</p>
      <h2>1. Information We Collect</h2>
      <p>HIGH-SPEED CONNECTION BOT collects only information reasonably necessary to provide its features:</p>
      <ul>
        <li>Discord user ID and server/guild ID</li>
        <li>Server membership and role information</li>
        <li>Voice-state information (which channel a member is in, whether their camera is on) — used only for camera policy enforcement and High-Speed Connection pairing</li>
        <li>Dashboard login information via Discord OAuth2 (username and guild membership) — used only to authenticate you and show the servers you manage</li>
      </ul>
      <h2>2. Information We Do Not Collect</h2>
      <p>HIGH-SPEED CONNECTION BOT does <strong>not</strong> collect or store: camera recordings, microphone recordings, audio or video of any kind, message content, passwords, or payment information.</p>
      <h2>3. High-Speed Connection Session Data</h2>
      <p>During an active High-Speed Connection event, the Bot stores in memory: which members have been paired together (to avoid repeats) and which members have been skipped (to avoid re-pairing). This data exists only for the duration of the session and is discarded when the session ends. It is never written to disk.</p>
      <h2>4. Server Configuration</h2>
      <p>HIGH-SPEED CONNECTION BOT stores per-server configuration (camera policy settings, channel index settings, High-Speed Connection settings) in JSON files on a persistent volume. This configuration is stored by server ID and does not contain personal information about individual members.</p>
      <h2>5. Dashboard OAuth2</h2>
      <p>The dashboard uses Discord OAuth2 to authenticate administrators. When you log in, we receive your Discord username, user ID, and a list of servers you belong to. This information is stored in a server-side session for the duration of your dashboard session only, and is used solely to determine which servers you are permitted to manage. We do not store your Discord credentials.</p>
      <h2>6. Data Storage</h2>
      <p>Configuration files are stored on a Fly.io persistent volume. Session data is stored server-side and expires after 7 days of inactivity. If HIGH-SPEED CONNECTION BOT is hosted on a third-party provider, that provider may have access to infrastructure on which the Bot operates, subject to their own policies.</p>
      <h2>7. Data Retention</h2>
      <p>Server configuration data is retained until the Bot is removed from a server or an administrator clears it. Dashboard session data expires automatically. High-Speed Connection session data is in-memory only and is not retained between sessions.</p>
      <h2>8. Your Privacy Rights</h2>
      <p>Depending on applicable law, you may have rights to request access to, correction of, or deletion of information associated with you. Requests may be sent to <a href="mailto:dragon.exe@atomicmail.io">dragon.exe@atomicmail.io</a>.</p>
      <h2>9. Children's Privacy</h2>
      <p>HIGH-SPEED CONNECTION BOT is not specifically directed toward children. You must comply with Discord's age requirements when using Discord and HIGH-SPEED CONNECTION BOT.</p>
      <h2>10. Changes to This Policy</h2>
      <p>We may update this Privacy Policy when our practices, features, or legal obligations change. The current version will be available at <a href="/privacy">high-speed-connection.fly.dev</a>.</p>
      <h2>11. Contact</h2>
      <p>Privacy questions: <a href="mailto:dragon.exe@atomicmail.io">dragon.exe@atomicmail.io</a></p>
    </div></div>`;
  res.send(renderLayout({ title: 'Privacy Policy', guildId, currentPath: '/privacy', body, allowedGuildIds }));
});
// Speed Match dashboard page
app.get('/speed-match', (req, res) => {
  const guildId = resolveGuildId(req); const allowedGuildIds = req.session.allowedGuildIds || [];
  const guild = client.guilds.cache.get(guildId); if (!guild) return res.redirect('/');
  const cfg = ensureVcShuffleGuildConfig(guildId); const state = shuffleState.get(guildId);
  const voiceChannels = [...guild.channels.cache.filter(c => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice).values()].sort((a,b) => a.rawPosition - b.rawPosition);
  const textChannels  = [...guild.channels.cache.filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement).values()].sort((a,b) => a.rawPosition - b.rawPosition);
  const categories    = [...guild.channels.cache.filter(c => c.type === ChannelType.GuildCategory).values()].sort((a,b) => a.rawPosition - b.rawPosition);
  const roles         = [...guild.roles.cache.filter(r => !r.managed && r.id !== guild.id).values()].sort((a,b) => b.rawPosition - a.rawPosition);
  const allRoles      = [...guild.roles.cache.values()].sort((a,b) => b.rawPosition - a.rawPosition);
  const nextIn = state?.nextShuffleAt ? new Date(state.nextShuffleAt).toLocaleString() : 'N/A';
  const poolSize = collectPoolMembers(guild, cfg).length;
  const modeLabel = cfg.connectionMode === 'role-based' ? 'Role-Based' : ((cfg.minGroupSize ?? 1) === 1 ? '1-on-1' : `${cfg.minGroupSize}v${cfg.minGroupSize}`);
  const lobbyChecklist = voiceChannels.map(c => `<label class="check-item"><input type="checkbox" name="lobbyChannelIds" value="${c.id}" ${cfg.lobbyChannelIds.includes(c.id) ? 'checked' : ''}> 🔊 ${escapeHtml(c.name)}</label>`).join('') || '<p class="muted">No voice channels.</p>';
  const categoryOptions = `<option value="">-- top-level --</option>` + categories.map(c => `<option value="${c.id}" ${cfg.categoryId === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
  const announceOptions = `<option value="">-- none --</option>` + textChannels.map(c => `<option value="${c.id}" ${cfg.announcementChannelId === c.id ? 'selected' : ''}>#${escapeHtml(c.name)}</option>`).join('');
  const participantRoleOptions = `<option value="">-- none --</option>` + roles.map(r => `<option value="${r.id}" ${cfg.participantRoleId === r.id ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('');
  const botRoleOptions = `<option value="">-- none --</option>` + allRoles.map(r => `<option value="${r.id}" ${cfg.botRoleId === r.id ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('');
  const staffRoleChecklist = roles.map(r => `<label class="check-item"><input type="checkbox" name="staffRoleIds" value="${r.id}" ${(cfg.staffRoleIds || []).includes(r.id) ? 'checked' : ''}> ${escapeHtml(r.name)}</label>`).join('') || '<p class="muted">No roles.</p>';
  const holdingOptions = `<option value="">-- falls back to lobby --</option>` + voiceChannels.map(c => `<option value="${c.id}" ${cfg.holdingChannelId === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
  const poolsDisplay = (cfg.pairingPools || []).length
    ? cfg.pairingPools.map((p, i) => `<div style="background:#0d0d14;border:1px solid var(--panel-border);border-radius:8px;padding:10px;margin-bottom:8px;"><strong>${escapeHtml(p.poolName)}</strong> — pairs with: <em>${p.pairWith === 'self' ? 'each other' : `"${escapeHtml(p.otherPoolName || '')}"`}</em><br><span class="muted">Roles: ${p.roleIds.join(', ')}</span><form method="POST" action="/speed-match/delete-pool" style="display:inline;margin-left:8px;"><input type="hidden" name="guild" value="${guildId}"><input type="hidden" name="poolIndex" value="${i}"><button type="submit" class="danger" style="padding:3px 8px;font-size:12px;">Delete</button></form></div>`).join('')
    : '<p class="muted">No pools configured yet.</p>';

  const body = `
    <div class="card"><h2>💨 High-Speed Connection — ${escapeHtml(guild.name)}</h2>
      <p><span class="pill ${cfg.enabled ? 'on' : 'off'}">${cfg.enabled ? 'RUNNING' : 'STOPPED'}</span> <span class="muted" style="margin-left:8px;">Mode: ${modeLabel}</span></p>
      <div class="stat-grid">
        <div class="stat"><div class="num">${state?.roundNumber ?? 0}</div><div class="label">Rounds completed</div></div>
        <div class="stat"><div class="num">${state?.pairHistory?.size ?? 0}</div><div class="label">Unique pairs</div></div>
        <div class="stat"><div class="num">${state?.skipHistory?.size ?? 0}</div><div class="label">Unique skips</div></div>
        <div class="stat"><div class="num">${poolSize}</div><div class="label">In lobby now</div></div>
        <div class="stat"><div class="num">${cfg.minIntervalMinutes}m</div><div class="label">Round length</div></div>
      </div>
      ${cfg.enabled ? `<p class="muted">Next bell at: ${nextIn}</p>` : ''}
      <div class="btn-row">
        <form method="POST" action="/speed-match/start"><input type="hidden" name="guild" value="${guildId}"><button type="submit" ${cfg.enabled ? 'disabled style="opacity:.5;"' : ''}>▶️ Start</button></form>
        <form method="POST" action="/speed-match/stop"><input type="hidden" name="guild" value="${guildId}"><button class="danger" type="submit" ${!cfg.enabled ? 'disabled style="opacity:.5;"' : ''}>⏹️ End Session</button></form>
        <form method="POST" action="/speed-match/shuffle-now"><input type="hidden" name="guild" value="${guildId}"><button class="secondary" type="submit">🔔 Ring Bell Now</button></form>
      </div></div>

    <div class="card"><form method="POST" action="/speed-match/save-settings"><input type="hidden" name="guild" value="${guildId}">
      <h3>Round Timing</h3>
      <div class="row">
        <div class="field"><label>Round length min (minutes)</label><input type="number" name="minIntervalMinutes" min="1" max="60" value="${cfg.minIntervalMinutes ?? 3}"></div>
        <div class="field"><label>Round length max (minutes)</label><input type="number" name="maxIntervalMinutes" min="1" max="60" value="${cfg.maxIntervalMinutes ?? 3}"></div>
        <div class="field"><label>Warning before bell (seconds)</label><input type="number" name="warningSeconds" min="5" max="300" value="${cfg.warningSeconds ?? 30}"></div>
      </div>
      <h3>Pairing Mode</h3>
      <div class="field"><label>Connection Mode</label>
        <select name="connectionMode">
          <option value="standard" ${cfg.connectionMode !== 'role-based' ? 'selected' : ''}>Standard (1-on-1 anti-repeat)</option>
          <option value="role-based" ${cfg.connectionMode === 'role-based' ? 'selected' : ''}>Role-Based (pools)</option>
        </select></div>
      <div class="field"><label>Group size (1 = 1-on-1)</label><div class="row">
        <input type="number" name="minGroupSize" min="1" max="10" value="${cfg.minGroupSize ?? 1}" style="width:80px;">
        <span style="padding-top:8px;color:var(--text-dim);">to</span>
        <input type="number" name="maxGroupSize" min="1" max="10" value="${cfg.maxGroupSize ?? 1}" style="width:80px;">
      </div></div>
      <h3>Channels</h3>
      <div class="row">
        <div class="field"><label>Room category</label><select name="categoryId">${categoryOptions}</select></div>
        <div class="field"><label>Announcement channel</label><select name="announcementChannelId">${announceOptions}</select></div>
      </div>
      <div class="btn-row"><button type="submit">💾 Save Settings</button></div>
    </form></div>

    <div class="card"><h3>Holding Channel (for Skip)</h3>
      <p class="muted">When a member clicks ⏭️ Skip, they are moved here silently until the bell rings. Falls back to lobby if not set.</p>
      <form method="POST" action="/speed-match/save-holding"><input type="hidden" name="guild" value="${guildId}">
        <div class="field"><label>Holding voice channel</label><select name="holdingChannelId">${holdingOptions}</select></div>
        <div class="btn-row"><button type="submit">💾 Save Holding Channel</button></div>
      </form></div>

    <div class="card"><form method="POST" action="/speed-match/save-roles"><input type="hidden" name="guild" value="${guildId}">
      <h3>Roles</h3>
      <div class="row">
        <div class="field"><label>Participant role</label><select name="participantRoleId">${participantRoleOptions}</select></div>
        <div class="field"><label>Bot role</label><select name="botRoleId">${botRoleOptions}</select></div>
      </div>
      <h3>Staff Roles</h3>
      <div class="checklist">${staffRoleChecklist}</div>
      <div class="btn-row"><button type="submit">💾 Save Roles</button></div>
    </form></div>

    <div class="card"><form method="POST" action="/speed-match/save-lobbies"><input type="hidden" name="guild" value="${guildId}">
      <h3>Lobby Channels</h3>
      <div class="checklist">${lobbyChecklist}</div>
      <div class="btn-row"><button type="submit">💾 Save Lobbies</button></div>
    </form></div>

    <div class="card"><h3>🎭 Role-Based Pairing Pools</h3>
      <p class="muted">Only used when Connection Mode is <strong>Role-Based</strong>. Define which roles pair together.</p>
      ${poolsDisplay}
      <form method="POST" action="/speed-match/add-pool"><input type="hidden" name="guild" value="${guildId}">
        <h3 style="margin-top:16px;">Add Pairing Pool</h3>
        <div class="row">
          <div class="field"><label>Pool name (e.g. "Girls", "Gay Men")</label><input type="text" name="poolName" placeholder="Pool name"></div>
          <div class="field"><label>Pairs with</label><select name="pairWith"><option value="self">Each other (within pool)</option><option value="other">Another pool</option></select></div>
          <div class="field"><label>Other pool name (if pairing with another)</label><input type="text" name="otherPoolName" placeholder="Leave blank if pairing within pool"></div>
        </div>
        <div class="field"><label>Role IDs (comma-separated — right-click role in Discord → Copy ID)</label><input type="text" name="roleIds" placeholder="111111111111, 222222222222"></div>
        <div class="btn-row"><button type="submit">Add Pool</button></div>
      </form></div>

    <div class="card"><h3>🏗️ Set Up Event Channels</h3>
      <p class="muted">Creates the full channel structure — category, info, matchups, master panel, lobby, holding VC, and 8 cloud rooms.</p>
      <p class="muted">Set up <strong>Participant Role</strong>, <strong>Staff Roles</strong>, and <strong>Bot Role</strong> first — channel permissions are built from those values.</p>
      <form method="POST" action="/speed-match/setup-channels"><input type="hidden" name="guild" value="${guildId}">
        <div class="btn-row"><button type="submit">🏗️ ${cfg.eventCategoryId ? 'Re-run Setup / Refresh Panel' : 'Create Event Channels'}</button></div>
      </form></div>`;
  res.send(renderLayout({ title: '💨 High-Speed Connection', guildId, currentPath: '/speed-match', body, flash: req.query.flash, allowedGuildIds }));
});

app.post('/speed-match/save-settings', (req, res) => {
  const guildId = req.body.guild; if (!guildId) return res.redirect('/');
  const cfg = ensureVcShuffleGuildConfig(guildId);
  cfg.minIntervalMinutes = Math.max(1, parseInt(req.body.minIntervalMinutes, 10) || 3);
  cfg.maxIntervalMinutes = Math.max(cfg.minIntervalMinutes, parseInt(req.body.maxIntervalMinutes, 10) || 3);
  cfg.minGroupSize = Math.max(1, parseInt(req.body.minGroupSize, 10) || 1);
  cfg.maxGroupSize = Math.max(cfg.minGroupSize, parseInt(req.body.maxGroupSize, 10) || 1);
  cfg.categoryId = req.body.categoryId || null;
  cfg.announcementChannelId = req.body.announcementChannelId || null;
  cfg.warningSeconds = Math.min(300, Math.max(5, parseInt(req.body.warningSeconds, 10) || 30));
  cfg.connectionMode = req.body.connectionMode || 'standard';
  saveVcShuffleConfig(vcShuffleConfig);
  res.redirect(`/speed-match?guild=${guildId}&flash=${encodeURIComponent('Settings saved!')}`);
});
app.post('/speed-match/save-holding', (req, res) => {
  const guildId = req.body.guild; if (!guildId) return res.redirect('/');
  const cfg = ensureVcShuffleGuildConfig(guildId);
  cfg.holdingChannelId = req.body.holdingChannelId || null;
  saveVcShuffleConfig(vcShuffleConfig);
  res.redirect(`/speed-match?guild=${guildId}&flash=${encodeURIComponent('Holding channel saved!')}`);
});
app.post('/speed-match/save-roles', (req, res) => {
  const guildId = req.body.guild; if (!guildId) return res.redirect('/');
  const cfg = ensureVcShuffleGuildConfig(guildId);
  cfg.participantRoleId = req.body.participantRoleId || null;
  cfg.botRoleId = req.body.botRoleId || null;
  cfg.staffRoleIds = asArray(req.body.staffRoleIds);
  saveVcShuffleConfig(vcShuffleConfig);
  res.redirect(`/speed-match?guild=${guildId}&flash=${encodeURIComponent('Roles saved!')}`);
});
app.post('/speed-match/save-lobbies', (req, res) => {
  const guildId = req.body.guild; if (!guildId) return res.redirect('/');
  const cfg = ensureVcShuffleGuildConfig(guildId);
  cfg.lobbyChannelIds = asArray(req.body.lobbyChannelIds);
  saveVcShuffleConfig(vcShuffleConfig);
  res.redirect(`/speed-match?guild=${guildId}&flash=${encodeURIComponent('Lobby channels saved!')}`);
});
app.post('/speed-match/add-pool', (req, res) => {
  const guildId = req.body.guild; if (!guildId) return res.redirect('/');
  const cfg = ensureVcShuffleGuildConfig(guildId);
  const poolName = (req.body.poolName || '').trim();
  const pairWith = req.body.pairWith || 'self';
  const otherPoolName = (req.body.otherPoolName || '').trim();
  const roleIds = (req.body.roleIds || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!poolName || !roleIds.length) return res.redirect(`/speed-match?guild=${guildId}&flash=${encodeURIComponent('Pool name and at least one role ID are required.')}`);
  if (!cfg.pairingPools) cfg.pairingPools = [];
  cfg.pairingPools.push({ poolName, pairWith, otherPoolName: pairWith === 'other' ? otherPoolName : '', roleIds });
  saveVcShuffleConfig(vcShuffleConfig);
  res.redirect(`/speed-match?guild=${guildId}&flash=${encodeURIComponent(`Pool "${poolName}" added.`)}`);
});
app.post('/speed-match/delete-pool', (req, res) => {
  const guildId = req.body.guild; if (!guildId) return res.redirect('/');
  const cfg = ensureVcShuffleGuildConfig(guildId);
  const idx = parseInt(req.body.poolIndex, 10);
  if (!isNaN(idx) && cfg.pairingPools?.[idx]) cfg.pairingPools.splice(idx, 1);
  saveVcShuffleConfig(vcShuffleConfig);
  res.redirect(`/speed-match?guild=${guildId}&flash=${encodeURIComponent('Pool deleted.')}`);
});
app.post('/speed-match/start', async (req, res) => {
  const guildId = req.body.guild; if (!guildId) return res.redirect('/');
  const guild = client.guilds.cache.get(guildId); const cfg = ensureVcShuffleGuildConfig(guildId);
  if (!cfg.lobbyChannelIds.length) return res.redirect(`/speed-match?guild=${guildId}&flash=${encodeURIComponent('Add at least one lobby channel first.')}`);
  await startVcShuffle(guild, guildId, true);
  res.redirect(`/speed-match?guild=${guildId}&flash=${encodeURIComponent('Session started!')}`);
});
app.post('/speed-match/stop', async (req, res) => {
  const guildId = req.body.guild; if (!guildId) return res.redirect('/');
  await stopVcShuffle(client.guilds.cache.get(guildId), guildId);
  res.redirect(`/speed-match?guild=${guildId}&flash=${encodeURIComponent('Session stopped. Rooms cleaned up.')}`);
});
app.post('/speed-match/shuffle-now', async (req, res) => {
  const guildId = req.body.guild; if (!guildId) return res.redirect('/');
  const guild = client.guilds.cache.get(guildId); const state = shuffleState.get(guildId);
  if (state?.warningTimeoutId) { clearTimeout(state.warningTimeoutId); state.warningTimeoutId = null; }
  await postBellMessage(guild, guildId); await runShuffleRound(guild, guildId); scheduleNextShuffle(guild, guildId);
  res.redirect(`/speed-match?guild=${guildId}&flash=${encodeURIComponent('Bell rung! Timer reset.')}`);
});

app.post('/speed-match/setup-channels', async (req, res) => {
  const guildId = req.body.guild; if (!guildId) return res.redirect('/');
  const guild = client.guilds.cache.get(guildId); const cfg = ensureVcShuffleGuildConfig(guildId);
  const { PermissionFlagsBits: PF } = require('discord.js');
  async function ct(createOpts, overwrites, reason) {
    const ch = await guild.channels.create({ ...createOpts, reason });
    if (overwrites?.length) { try { await ch.permissionOverwrites.set(overwrites, reason); } catch (err) { console.warn(`[setup] overwrites ${ch.name}: ${err.message}`); } }
    return ch;
  }
  try {
    const botId = client.user.id;
    const botOW     = { id: botId,    allow: [PF.ViewChannel, PF.SendMessages, PF.ReadMessageHistory, PF.ManageMessages, PF.ManageChannels, PF.Connect, PF.MoveMembers] };
    const evDeny    = { id: guild.id, deny:  [PF.ViewChannel, PF.Connect] };
    const evReadOnly= { id: guild.id, deny:  [PF.SendMessages, PF.CreatePublicThreads], allow: [PF.ViewChannel, PF.ReadMessageHistory] };
    const staffOW   = (cfg.staffRoleIds || []).map(id => ({ id, allow: [PF.ViewChannel, PF.SendMessages, PF.ReadMessageHistory, PF.ManageMessages, PF.Connect, PF.Speak, PF.MoveMembers] }));
    const partVC    = cfg.participantRoleId ? [{ id: cfg.participantRoleId, allow: [PF.ViewChannel, PF.Connect, PF.Speak, PF.UseVAD, PF.Stream] }] : [];
    const partRead  = cfg.participantRoleId ? [{ id: cfg.participantRoleId, allow: [PF.ViewChannel, PF.ReadMessageHistory] }] : [];

    let category = cfg.eventCategoryId ? guild.channels.cache.get(cfg.eventCategoryId) : null;
    if (!category) { category = await ct({ name: '💨・ʜɪɢʜ-sᴘᴇᴇᴅ・ᴄᴏɴɴᴇᴄᴛɪᴏɴ', type: ChannelType.GuildCategory }, [evDeny, botOW, ...staffOW], '💨 HSC setup'); cfg.eventCategoryId = category.id; cfg.categoryId = category.id; }
    let infoCh = cfg.infoChannelId ? guild.channels.cache.get(cfg.infoChannelId) : null;
    if (!infoCh) { infoCh = await ct({ name: '💨・ɪɴꜰᴏ', type: ChannelType.GuildText, parent: category.id }, [evReadOnly, botOW, ...staffOW, ...partRead], '💨 HSC info'); cfg.infoChannelId = infoCh.id; }
    let matchupsCh = cfg.matchupsChannelId ? guild.channels.cache.get(cfg.matchupsChannelId) : null;
    if (!matchupsCh) { matchupsCh = await ct({ name: '💨・ᴍᴀᴛᴄʜ-ᴜᴘs', type: ChannelType.GuildText, parent: category.id }, [evReadOnly, botOW, ...staffOW, ...partRead], '💨 HSC matchups'); cfg.matchupsChannelId = matchupsCh.id; cfg.announcementChannelId = matchupsCh.id; }
    let panelCh = cfg.staffPanelChannelId ? guild.channels.cache.get(cfg.staffPanelChannelId) : null;
    if (!panelCh) { panelCh = await ct({ name: '💨・ᴍᴀsᴛᴇʀ・ᴘᴀɴᴇʟ', type: ChannelType.GuildText, parent: category.id }, [evDeny, botOW, ...staffOW], '💨 HSC panel'); cfg.staffPanelChannelId = panelCh.id; }
    let lobbyCh = cfg.lobbyChannelIds?.[0] ? guild.channels.cache.get(cfg.lobbyChannelIds[0]) : null;
    if (!lobbyCh) { lobbyCh = await ct({ name: '💨・ᴄᴏɴɴᴇᴄᴛɪᴏɴ・ʟᴏʙʙʏ', type: ChannelType.GuildVoice, parent: category.id }, [evDeny, botOW, ...staffOW, ...partVC], '💨 HSC lobby'); cfg.lobbyChannelIds = [lobbyCh.id]; }

    if (!cfg.holdingChannelId) {
      const holdingCh = await ct({ name: '💨・ʜᴏʟᴅɪɴɢ', type: ChannelType.GuildVoice, parent: category.id }, [evDeny, botOW, ...staffOW, ...partVC], '💨 HSC holding');
      cfg.holdingChannelId = holdingCh.id;
    }

    const CLOUD_ROOM_COUNT = 8;
    if (!cfg.cloudRoomIds) cfg.cloudRoomIds = [];
    cfg.cloudRoomIds = [...new Set(cfg.cloudRoomIds)].filter(id => guild.channels.cache.has(id));
    const existingCloudNames = new Map();
    for (const [id, ch] of guild.channels.cache) { if (ch.parentId === category.id && ch.type === ChannelType.GuildVoice) existingCloudNames.set(ch.name, id); }
    for (let i = cfg.cloudRoomIds.length; i < CLOUD_ROOM_COUNT; i++) {
      const roomName = `💨・ᴄʟᴏᴜᴅ・ʀᴏᴏᴍ・${i + 1}`;
      if (existingCloudNames.has(roomName)) { const eid = existingCloudNames.get(roomName); if (!cfg.cloudRoomIds.includes(eid)) cfg.cloudRoomIds.push(eid); continue; }
      await new Promise(r => setTimeout(r, 800));
      const room = await ct({ name: roomName, type: ChannelType.GuildVoice, parent: category.id }, [evDeny, botOW, ...staffOW], `💨 HSC cloud room ${i + 1}`);
      cfg.cloudRoomIds.push(room.id); existingCloudNames.set(roomName, room.id);
    }
    saveVcShuffleConfig(vcShuffleConfig);

    try {
      const existing = await infoCh.messages.fetch({ limit: 5 });
      if (!existing.some(m => m.author.id === botId)) {
        const infoEmbed = new EmbedBuilder().setColor(0x8a2be2).setTitle('💨 High-Speed Connection — How It Works')
          .setDescription(`Welcome to **💨 High-Speed Connection** — speed match, VC style!\n\n**1. 🚪 Join the lobby**\nHop into <#${lobbyCh.id}>. You're automatically in the pool for the next round.\n\n**2. 💘 Get matched**\nWhen the round starts you'll be moved into a private cloud room with your match.\n\n**3. 🔁 Match Again / ⏭️ Skip**\nButtons appear in your room. Both must vote Match Again to re-pair next round. Hitting Skip moves you to holding silently.\n\n**4. 🔔 The bell rings**\nYou'll get a heads-up before the round ends, then everyone rotates to new rooms.\n\n**5. 🚫 No repeats**\nThe bot remembers who you've already talked to.\n\n**6. 📋 Matchups**\nEach round's pairings are posted in <#${matchupsCh.id}>!`)
          .setFooter({ text: '💨 High-Speed Connection · Managed by HIGH-SPEED CONNECTION BOT' }).setTimestamp();
        await infoCh.send({ embeds: [infoEmbed] });
      }
    } catch (err) { console.error('[speed-match] info embed:', err.message); }

    cfg.staffPanelMessageId = null; saveVcShuffleConfig(vcShuffleConfig);
    await refreshStaffPanel(guild, guildId);
    res.redirect(`/speed-match?guild=${guildId}&flash=${encodeURIComponent('✅ All channels created! Check 💨・ᴍᴀsᴛᴇʀ・ᴘᴀɴᴇʟ for the live control panel.')}`);
  } catch (err) {
    console.error('[speed-match] setup-channels error:', err);
    res.redirect(`/speed-match?guild=${guildId}&flash=${encodeURIComponent('Setup failed — ' + err.message)}`);
  }
});

app.listen(PORT, () => { console.log(`[dashboard] Listening on port ${PORT}`); });
client.login(TOKEN);
