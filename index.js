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
  EmbedBuilder,
  ChannelType,
} = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID; // your server ID

if (!TOKEN || !GUILD_ID) {
  console.error('Missing DISCORD_TOKEN or GUILD_ID in your .env file.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
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
  '1520163360606261288',
  '1524248909013319781',
  '1522050201538265099',
  '1522056203138764971',
  '1522453146486575196',
  '1522918807285530745',
  '1523688048561225768',
  '1527071150121685172',
  '1529904624767602901',
  '1520729269087506534',
  '1531770010136215602',
  '1532107616673861834',
  '1532117032902983880',
  '1532800372979138592',
  '1532812512607731923',
  '1508218846769578246',
  '1510678526087659590',
  '1524605236801699923',
  '1524614965074464858',
  '1524615350749106336',
  '1495554128599056524',
  '1495554206936072432',
  '1516280215897247906',
  '1521284113741385960',
  '1524403215213396028',
  '1531986003219320922',
  '1519762749058584636',
  '1495553806421983262',
  '1495553933949800639',
  '1495554006104145941',
  '1495554063192948797',
  '1533479251729453066',
  '1491731146910863450',
  '1491253285070573620',
  '1491731275038331061',
  '1491730897249243136',
  '1522171628509990984',
  '1532586175791890532',
  '1531967288519954482',
  '1529727284259459175',
  '1522178212174495794',
  '1521955739797688521', 
  '1517124329970598100',
  '1519141748507414628',
  '1519142187663757493',
  '1533402418425892934',
  '1522370333129310288',
  '1532873914210844893',
  '1531203296595804170',
  '1532734139818574056',
  '1518798228873674903',
  '1529699257118888078',
  '1530774680418386090',
  '1517124477794910338',
  '1530703669048246272',
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

// Prevent one bad interaction, network hiccup, or unexpected error from
// crashing the whole bot process. It gets logged instead, and the bot stays online.
client.on('error', (err) => {
  console.error('Discord client error:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (bot stays online):', err);
});

client.login(TOKEN);
