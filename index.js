/**
 * ═══════════════════════════════════════════════════════════════════════
 *  Roblox Moderation Bot — Discord → Roblox (No API Key Needed)
 *  Kick/Ban/Unban players directly from Discord
 * ═══════════════════════════════════════════════════════════════════════
 *
 *  How it works:
 *    - Discord slash commands queue moderation actions on this bot
 *    - The Roblox game polls this bot every 5 seconds via HttpService
 *    - Roblox picks up commands, kicks/bans players, stores bans in DataStore
 *    - No Roblox Open Cloud API key required!
 *
 *  Setup:
 *    1. Copy .env.example → .env and fill in your tokens
 *    2. npm install
 *    3. node deploy-commands.js   (once, to register slash commands)
 *    4. node index.js             (run the bot)
 *
 *  Commands:
 *    /kick     <username> <reason>
 *    /ban      <username> <duration> <reason>
 *    /unban    <username>
 *    /baninfo  <username>
 */

require("dotenv").config();
const http = require("http");
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionFlagsBits,
} = require("discord.js");

// ─── Config ───
const POLL_SECRET = process.env.POLL_SECRET || "changeme";
const PORT = process.env.PORT || 3000;

// ─── Command Queue ───
// All game servers poll this queue. Commands stay for 60s so every server sees them.
const commandQueue = [];
let commandIdCounter = 0;

function queueCommand(cmd) {
  commandIdCounter++;
  cmd.id = commandIdCounter;
  cmd.timestamp = Date.now();
  commandQueue.push(cmd);
}

// Cleanup commands older than 60 seconds
setInterval(() => {
  const cutoff = Date.now() - 60000;
  while (commandQueue.length > 0 && commandQueue[0].timestamp < cutoff) {
    commandQueue.shift();
  }
}, 10000);

// ─── Ban record cache (in-memory, for /baninfo) ───
const banCache = new Map(); // userId -> banData

// ─── Roblox API helpers ───

async function resolvePlayer(input) {
  if (/^\d+$/.test(input)) {
    const res = await fetch(`https://users.roblox.com/v1/users/${input}`);
    if (!res.ok) return null;
    const data = await res.json();
    return { userId: data.id, username: data.name };
  }

  const res = await fetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usernames: [input], excludeBannedUsers: false }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.data || data.data.length === 0) return null;
  return { userId: data.data[0].id, username: data.data[0].name };
}

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

// ─── Duration parsing ───

function parseDuration(input) {
  const lower = input.toLowerCase().trim();
  if (lower === "perm" || lower === "permanent") return -1;
  const match = lower.match(/^(\d+)(m|h|d)$/);
  if (!match) return null;
  const num = parseInt(match[1]);
  switch (match[2]) {
    case "m": return num * 60;
    case "h": return num * 3600;
    case "d": return num * 86400;
    default: return null;
  }
}

function formatDuration(seconds) {
  if (seconds === -1) return "Permanent";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours`;
  return `${Math.floor(seconds / 86400)} days`;
}

// ─── HTTP Server (keep-alive + poll endpoint for Roblox) ───

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Health check
  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        status: "online",
        bot: client.user?.tag || "starting...",
        uptime: Math.floor(process.uptime()),
        pendingCommands: commandQueue.length,
      })
    );
  }

  // Poll endpoint — Roblox calls this every 5 seconds
  if (url.pathname === "/poll" && req.method === "GET") {
    const key = url.searchParams.get("key");
    if (key !== POLL_SECRET) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Invalid key" }));
    }

    const since = parseInt(url.searchParams.get("since")) || 0;
    const commands = commandQueue.filter((c) => c.id > since);

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ commands }));
  }

  // Baninfo endpoint — Roblox can report ban status back (optional)
  if (url.pathname === "/bancheck" && req.method === "GET") {
    const key = url.searchParams.get("key");
    if (key !== POLL_SECRET) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Invalid key" }));
    }

    const userId = url.searchParams.get("userId");
    const ban = banCache.get(userId);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ banned: !!ban, data: ban || null }));
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`HTTP server running on port ${PORT}`);
});

// ─── Discord Bot ───

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // Permission check
  if (!interaction.member.permissions.has(PermissionFlagsBits.BanMembers)) {
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xff0000)
          .setTitle("No Permission")
          .setDescription(
            "You need the **Ban Members** permission to use this."
          ),
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

    queueCommand({
      action: "kick",
      userId: player.userId,
      username: player.username,
      reason: reason,
      moderator: interaction.user.tag,
    });

    const avatar = await getAvatarUrl(player.userId);

    const embed = new EmbedBuilder()
      .setColor(0xffa500)
      .setTitle("Player Kicked")
      .setDescription(
        `**${player.username}** will be kicked from all servers.`
      )
      .addFields(
        { name: "User ID", value: `${player.userId}`, inline: true },
        { name: "Reason", value: reason, inline: true },
        { name: "Moderator", value: interaction.user.tag, inline: true }
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

    queueCommand({
      action: "ban",
      userId: player.userId,
      username: player.username,
      reason: reason,
      duration: durationSec,
      bannedAt: now,
      moderator: interaction.user.tag,
    });

    // Cache ban locally for /baninfo
    banCache.set(String(player.userId), {
      reason,
      duration: durationSec,
      bannedAt: now,
      expiresAt: durationSec === -1 ? -1 : now + durationSec,
      moderator: interaction.user.tag,
      username: player.username,
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
        { name: "Moderator", value: interaction.user.tag, inline: true },
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

    queueCommand({
      action: "unban",
      userId: player.userId,
      username: player.username,
      moderator: interaction.user.tag,
    });

    // Remove from local cache
    banCache.delete(String(player.userId));

    const avatar = await getAvatarUrl(player.userId);

    const embed = new EmbedBuilder()
      .setColor(0x00ff00)
      .setTitle("Player Unbanned")
      .setDescription(`**${player.username}** has been unbanned.`)
      .addFields(
        { name: "User ID", value: `${player.userId}`, inline: true },
        { name: "Moderator", value: interaction.user.tag, inline: true }
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

    const ban = banCache.get(String(player.userId));
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
        })
        .setFooter({
          text: "Note: Only tracks bans issued since bot started",
        });
      if (avatar) embed.setThumbnail(avatar);
      return interaction.editReply({ embeds: [embed] });
    }

    // Check if expired
    const now = Math.floor(Date.now() / 1000);
    if (ban.expiresAt !== -1 && ban.expiresAt <= now) {
      banCache.delete(String(player.userId));
      const embed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle("Ban Expired")
        .setDescription(
          `**${player.username}**'s ban has expired.`
        )
        .addFields(
          {
            name: "Original Reason",
            value: ban.reason || "N/A",
            inline: true,
          },
          {
            name: "Was Banned By",
            value: ban.moderator || "Unknown",
            inline: true,
          }
        );
      if (avatar) embed.setThumbnail(avatar);
      return interaction.editReply({ embeds: [embed] });
    }

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
          value:
            ban.expiresAt === -1 ? "Never" : `<t:${ban.expiresAt}:R>`,
          inline: true,
        }
      )
      .setTimestamp();

    if (avatar) embed.setThumbnail(avatar);
    return interaction.editReply({ embeds: [embed] });
  }
});

client.login(process.env.DISCORD_TOKEN);
