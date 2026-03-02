/**
 * Run this ONCE to register slash commands with Discord:
 *   node deploy-commands.js
 */
require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a player from all game servers")
    .addStringOption((o) =>
      o
        .setName("username")
        .setDescription("Roblox username or UserId")
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName("reason")
        .setDescription("Reason for the kick")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a player from the game")
    .addStringOption((o) =>
      o
        .setName("username")
        .setDescription("Roblox username or UserId")
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName("duration")
        .setDescription("Duration: 30m, 2h, 7d, 30d, or perm")
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName("reason")
        .setDescription("Reason for the ban")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Unban a player")
    .addStringOption((o) =>
      o
        .setName("username")
        .setDescription("Roblox username or UserId")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("baninfo")
    .setDescription("Check if a player is banned")
    .addStringOption((o) =>
      o
        .setName("username")
        .setDescription("Roblox username or UserId")
        .setRequired(true)
    ),
].map((c) => c.toJSON());

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log("Registering slash commands...");
    await rest.put(
      Routes.applicationGuildCommands(
        process.env.CLIENT_ID,
        process.env.GUILD_ID
      ),
      { body: commands }
    );
    console.log("Done! Commands registered.");
  } catch (err) {
    console.error(err);
  }
})();
