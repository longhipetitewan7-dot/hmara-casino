
require("dotenv").config();

const express = require("express");
const { Client, GatewayIntentBits } = require("discord.js");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    name: "Hmara Casino",
    status: "online",
    bot: process.env.DISCORD_BOT_TOKEN ? "configured" : "not_configured"
  });
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

if (process.env.DISCORD_BOT_TOKEN) {
  const bot = new Client({
    intents: [GatewayIntentBits.Guilds]
  });

  bot.once("ready", () => {
    console.log(`Bot connecté : ${bot.user.tag}`);
  });

  bot.login(process.env.DISCORD_BOT_TOKEN).catch((err) => {
    console.error("Connexion du bot impossible :", err.message);
  });
} else {
  console.log("Token Discord manquant : le serveur démarre sans bot.");
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Hmara Casino écoute sur le port ${PORT}`);
});
