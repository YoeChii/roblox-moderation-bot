/**
 * ═══════════════════════════════════════════════════════════════════════
 *  Roblox Moderation Bot — Discord → Roblox Open Cloud
 *  Kick/Ban/Unban players directly from Discord
 * ═══════════════════════════════════════════════════════════════════════
 *
 *  Setup:
 *    1. Copy .env.example → .env and fill in your tokens
 *    2. npm install
 *    3. node deploy-commands.js   (once, to register slash commands)
 *    4. node index.js             (run the bot)
 *
 *  Commands:
 *    /kick  <username> <reason>
 *    /ban   <username> <duration> <reason>
 *    /unban <username>
 *    /baninfo <username>
 */

require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionFlagsBits,
} = require("discord.js");

// ─── Config ───
const UNIVERSE_ID = process.env.UNIVERSE_ID;
const API_KEY = process.env.ROBLOX_API_KEY;
const DATASTORE_NAME = "DiscordBans";
const MESSAGING_TOPIC = "DiscordModeration";

// ─── Roblox API helpers ───

/**
 * Resolve a Roblox username (or raw userId string) → { userId, username }
 */
async function resolvePlayer(input) {
  // If input is a number, treat as userId
  if (/^\d+$/.test(input)) {
    const res = await fetch(
      `https://users.roblox.com/v1/users/${input}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    return { userId: data.id, username: data.name };
  }

  // Otherwise resolve username
  const res = await fetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      usernames: [input],
      excludeBannedUsers: false,
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.data || data.data.length === 0) return null;
  return { userId: data.data[0].id, username: data.data[0].name };
}

/**
 * Get a player's avatar thumbnail URL
 */
async function getAvatarUrl(userId) {
  try {
    const res = await fetch(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png`
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.data?.[0]?.imageUrl || null;
  } catch {
    return null;
  }
}

/**
 * Publish a message to all game servers via MessagingService Open Cloud API
 */
async function publishMessage(payload) {
  const url = `https://apis.roblox.com/messaging-service/v1/universes/${UNIVERSE_ID}/topics/${MESSAGING_TOPIC}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-api-key": API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message: JSON.stringify(payload) }),
  });
  return res.ok;
}

/**
 * Write a ban entry to DataStore via Open Cloud API
 */
async function writeBan(userId, banData) {
  const url =
    `https://apis.roblox.com/datastores/v1/universes/${UNIVERSE_ID}` +
    `/standard-datastores/datastore/entries/entry` +
    `?datastoreName=${DATASTORE_NAME}&entryKey=${userId}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-api-key": API_KEY,
      "Content-Type": "application/json",
      "roblox-entry-attributes": "{}",
      "roblox-entry-userids": `[${userId}]`,
    },
    body: JSON.stringify(banData),
  });
  return res.ok;
}

/**
 * Read a ban entry from DataStore
 */
async function readBan(userId) {
  const url =
    `https://apis.roblox.com/datastores/v1/universes/${UNIVERSE_ID}` +
    `/standard-datastores/datastore/entries/entry` +
    `?datastoreName=${DATASTORE_NAME}&entryKey=${userId}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { "x-api-key": API_KEY },
  });
  if (!res.ok) return null;
  return await res.json();
}

/**
 * Delete a ban entry from DataStore
 */
async function deleteBan(userId) {
  const url =
    `https://apis.roblox.com/datastores/v1/universes/${UNIVERSE_ID}` +
    `/standard-datastores/datastore/entries/entry` +
    `?datastoreName=${DATASTORE_NAME}&entryKey=${userId}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { "x-api-key": API_KEY },
  });
  return res.ok;
}

// ─── Duration parsing ───

/**
 * Parse duration string → seconds (or -1 for permanent)
 * Supports: 30m, 2h, 7d, 30d, perm/permanent
 */
function parseDuration(input) {
  const lower = input.toLowerCase().trim();
  if (lower === "perm" || lower === "permanent") return -1;

  const match = lower.match(/^(\d+)(m|h|d)$/);
  if (!match) return null;

  const num = parseInt(match[1]);
  const unit = match[2];

  switch (unit) {
    case "m":
      return num * 60;
    case "h":
      return num * 3600;
    case "d":
      return num * 86400;
    default:
      return null;
  }
}

/**
 * Format seconds into human-readable duration
 */
function formatDuration(seconds) {
  if (seconds === -1) return "Permanent";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours`;
  return `${Math.floor(seconds / 86400)} days`;
}

// ─── Discord Bot ───

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // Permission check — only users with BanMembers can use moderation
  if (!interaction.member.permissions.has(PermissionFlagsBits.BanMembers)) {
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xff0000)
          .setTitle("No Permission")
          .setDescription("You need the **Ban Members** permission to use this."),
      ],
      ephemeral: true,
    });
  }

  const { commandName } = interaction;

  // ─── /kick ───
  if (commandName === "kick") {
    await interaction.deferReply();

    const input = interaction.options.getString("username");
    const reason = interaction.options.getString("reason");

    const player = await resolvePlayer(input);
    if (!player) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xff0000)
            .setTitle("Player Not Found")
            .setDescription(`Could not find Roblox user **${input}**.`),
        ],
      });
    }

    const avatar = await getAvatarUrl(player.userId);

    const sent = await publishMessage({
      action: "kick",
      userId: player.userId,
      username: player.username,
      reason: reason,
      moderator: interaction.user.tag,
    });

    if (!sent) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xff0000)
            .setTitle("API Error")
            .setDescription(
              "Failed to send kick command. Check your API key and permissions."
            ),
        ],
      });
    }

    const embed = new EmbedBuilder()
      .setColor(0xffa500)
      .setTitle("Player Kicked")
      .setDescription(`**${player.username}** has been kicked from all servers.`)
      .addFields(
        { name: "User ID", value: `${player.userId}`, inline: true },
        { name: "Reason", value: reason, inline: true },
        {
          name: "Moderator",
          value: interaction.user.tag,
          inline: true,
        }
      )
      .setTimestamp();

    if (avatar) embed.setThumbnail(avatar);

    return interaction.editReply({ embeds: [embed] });
  }

  // ─── /ban ───
  if (commandName === "ban") {
    await interaction.deferReply();

    const input = interaction.options.getString("username");
    const durationStr = interaction.options.getString("duration");
    const reason = interaction.options.getString("reason");

    const player = await resolvePlayer(input);
    if (!player) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xff0000)
            .setTitle("Player Not Found")
            .setDescription(`Could not find Roblox user **${input}**.`),
        ],
      });
    }

    const durationSec = parseDuration(durationStr);
    if (durationSec === null) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xff0000)
            .setTitle("Invalid Duration")
            .setDescription(
              "Use formats like `30m`, `2h`, `7d`, `30d`, or `perm`."
            ),
        ],
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const banData = {
      reason: reason,
      duration: durationSec,
      bannedAt: now,
      expiresAt: durationSec === -1 ? -1 : now + durationSec,
      moderator: interaction.user.tag,
      username: player.username,
    };

    // Write ban to DataStore (persists even if no servers are running)
    const stored = await writeBan(player.userId, banData);
    if (!stored) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xff0000)
            .setTitle("DataStore Error")
            .setDescription(
              "Failed to store ban. Check your API key has DataStore write permission."
            ),
        ],
      });
    }

    // Send message to all servers to kick immediately
    await publishMessage({
      action: "ban",
      userId: player.userId,
      username: player.username,
      reason: reason,
      duration: durationSec,
      moderator: interaction.user.tag,
    });

    const avatar = await getAvatarUrl(player.userId);

    const embed = new EmbedBuilder()
      .setColor(0xff0000)
      .setTitle("Player Banned")
      .setDescription(`**${player.username}** has been banned.`)
      .addFields(
        { name: "User ID", value: `${player.userId}`, inline: true },
        {
          name: "Duration",
          value: formatDuration(durationSec),
          inline: true,
        },
        { name: "Reason", value: reason, inline: true },
        {
          name: "Moderator",
          value: interaction.user.tag,
          inline: true,
        },
        {
          name: "Expires",
          value:
            durationSec === -1
              ? "Never"
              : `<t:${now + durationSec}:R>`,
          inline: true,
        }
      )
      .setTimestamp();

    if (avatar) embed.setThumbnail(avatar);

    return interaction.editReply({ embeds: [embed] });
  }

  // ─── /unban ───
  if (commandName === "unban") {
    await interaction.deferReply();

    const input = interaction.options.getString("username");
    const player = await resolvePlayer(input);
    if (!player) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xff0000)
            .setTitle("Player Not Found")
            .setDescription(`Could not find Roblox user **${input}**.`),
        ],
      });
    }

    // Check if they're actually banned
    const existing = await readBan(player.userId);
    if (!existing) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xffff00)
            .setTitle("Not Banned")
            .setDescription(`**${player.username}** is not currently banned.`),
        ],
      });
    }

    const deleted = await deleteBan(player.userId);
    if (!deleted) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xff0000)
            .setTitle("DataStore Error")
            .setDescription("Failed to remove ban from DataStore."),
        ],
      });
    }

    const avatar = await getAvatarUrl(player.userId);

    const embed = new EmbedBuilder()
      .setColor(0x00ff00)
      .setTitle("Player Unbanned")
      .setDescription(`**${player.username}** has been unbanned.`)
      .addFields(
        { name: "User ID", value: `${player.userId}`, inline: true },
        {
          name: "Moderator",
          value: interaction.user.tag,
          inline: true,
        }
      )
      .setTimestamp();

    if (avatar) embed.setThumbnail(avatar);

    return interaction.editReply({ embeds: [embed] });
  }

  // ─── /baninfo ───
  if (commandName === "baninfo") {
    await interaction.deferReply();

    const input = interaction.options.getString("username");
    const player = await resolvePlayer(input);
    if (!player) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xff0000)
            .setTitle("Player Not Found")
            .setDescription(`Could not find Roblox user **${input}**.`),
        ],
      });
    }

    const ban = await readBan(player.userId);
    const avatar = await getAvatarUrl(player.userId);

    if (!ban) {
      const embed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle("No Active Ban")
        .setDescription(`**${player.username}** is not banned.`)
        .addFields({
          name: "User ID",
          value: `${player.userId}`,
          inline: true,
        });
      if (avatar) embed.setThumbnail(avatar);
      return interaction.editReply({ embeds: [embed] });
    }

    // Check if expired
    const now = Math.floor(Date.now() / 1000);
    if (ban.expiresAt !== -1 && ban.expiresAt <= now) {
      // Ban expired — clean it up
      await deleteBan(player.userId);
      const embed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle("Ban Expired")
        .setDescription(
          `**${player.username}**'s ban has expired and been removed.`
        )
        .addFields(
          { name: "Original Reason", value: ban.reason || "N/A", inline: true },
          {
            name: "Was Banned By",
            value: ban.moderator || "Unknown",
            inline: true,
          }
        );
      if (avatar) embed.setThumbnail(avatar);
      return interaction.editReply({ embeds: [embed] });
    }

    // Active ban
    const embed = new EmbedBuilder()
      .setColor(0xff0000)
      .setTitle("Active Ban")
      .setDescription(`**${player.username}** is currently banned.`)
      .addFields(
        { name: "User ID", value: `${player.userId}`, inline: true },
        { name: "Reason", value: ban.reason || "N/A", inline: true },
        {
          name: "Duration",
          value: formatDuration(ban.duration),
          inline: true,
        },
        {
          name: "Banned By",
          value: ban.moderator || "Unknown",
          inline: true,
        },
        {
          name: "Banned At",
          value: `<t:${ban.bannedAt}:F>`,
          inline: true,
        },
        {
          name: "Expires",
          value: ban.expiresAt === -1 ? "Never" : `<t:${ban.expiresAt}:R>`,
          inline: true,
        }
      )
      .setTimestamp();

    if (avatar) embed.setThumbnail(avatar);

    return interaction.editReply({ embeds: [embed] });
  }
});

client.login(process.env.DISCORD_TOKEN);
