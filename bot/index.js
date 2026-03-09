const express = require("express");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");

// ─── Config from environment ──────────────────────────────────────────────────
const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const SECRET = process.env.BRIDGE_SECRET;
const PORT = process.env.PORT || 3000;

// ─── Startup logging ──────────────────────────────────────────────────────────
console.log("====================================");
console.log("Roblox-Discord Bridge Starting...");
console.log("====================================");
console.log("TOKEN exists:", TOKEN ? "yes (" + TOKEN.length + " chars)" : "NO!");
console.log("CHANNEL_ID:", CHANNEL_ID || "NOT SET!");
console.log("SECRET exists:", SECRET ? "yes" : "NO!");
console.log("PORT:", PORT);
console.log("====================================");

// ─── Validate config ──────────────────────────────────────────────────────────
if (!TOKEN) {
  console.error("ERROR: DISCORD_TOKEN environment variable is not set!");
  console.error("Add it in Render Dashboard -> Environment");
}

if (!CHANNEL_ID) {
  console.error("ERROR: DISCORD_CHANNEL_ID environment variable is not set!");
}

if (!SECRET) {
  console.error("ERROR: BRIDGE_SECRET environment variable is not set!");
}

// ─── State ────────────────────────────────────────────────────────────────────
let discordMessages = [];
let botReady = false;
let channel = null;

// ─── Discord Bot ──────────────────────────────────────────────────────────────
const bot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

bot.on("ready", async () => {
  console.log("====================================");
  console.log("BOT ONLINE: " + bot.user.tag);
  console.log("====================================");
  
  botReady = true;
  
  // Find the channel
  try {
    channel = await bot.channels.fetch(CHANNEL_ID);
    console.log("Channel found: #" + channel.name);
  } catch (err) {
    console.error("Could not find channel:", err.message);
  }
});

bot.on("messageCreate", (msg) => {
  // Ignore bots and wrong channel
  if (msg.author.bot) return;
  if (msg.channel.id !== CHANNEL_ID) return;
  
  // Clean the message
  let text = msg.content.substring(0, 200);
  text = text.replace(/[^\x20-\x7E]/g, ""); // ASCII only
  
  if (!text.trim()) return;
  
  // Queue for Roblox
  discordMessages.push({
    author: msg.author.displayName || msg.author.username,
    message: text,
    time: Date.now(),
  });
  
  // Keep queue small
  if (discordMessages.length > 100) {
    discordMessages = discordMessages.slice(-100);
  }
  
  console.log("[Discord] " + msg.author.username + ": " + text);
});

bot.on("error", (err) => {
  console.error("Bot error:", err.message);
});

// ─── Express Server ───────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.json({
    online: true,
    botReady: botReady,
    botUser: bot.user ? bot.user.tag : null,
    channelFound: channel ? true : false,
  });
});

// Auth check
function checkSecret(req, res, next) {
  if (req.headers["x-bridge-secret"] !== SECRET) {
    return res.status(403).json({ error: "bad secret" });
  }
  next();
}

// Roblox polls this to get Discord messages
app.get("/api/messages", checkSecret, (req, res) => {
  const since = parseInt(req.query.since) || 0;
  
  // Get messages after timestamp
  const msgs = discordMessages.filter((m) => m.time > since);
  
  // Clear old messages
  if (msgs.length > 0) {
    const latest = msgs[msgs.length - 1].time;
    discordMessages = discordMessages.filter((m) => m.time > latest);
  }
  
  res.json({
    messages: msgs.slice(0, 50),
    time: Date.now(),
  });
});

// Roblox sends messages here
app.post("/api/send", checkSecret, async (req, res) => {
  if (!channel) {
    return res.status(500).json({ error: "channel not found" });
  }
  
  const messages = req.body.messages;
  
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: "messages must be array" });
  }
  
  let sent = 0;
  
  for (const msg of messages.slice(0, 10)) {
    try {
      const username = String(msg.username || "Unknown").substring(0, 50);
      const content = String(msg.content || "").substring(0, 200);
      const type = msg.type || "chat";
      
      if (type === "join") {
        const embed = new EmbedBuilder()
          .setColor(0x00ff00)
          .setDescription("**" + username + "** joined the game");
        await channel.send({ embeds: [embed] });
      } else if (type === "leave") {
        const embed = new EmbedBuilder()
          .setColor(0xff0000)
          .setDescription("**" + username + "** left the game");
        await channel.send({ embeds: [embed] });
      } else if (content) {
        await channel.send("**[Roblox] " + username + ":** " + content);
      }
      
      sent++;
      
      // Small delay between messages
      await new Promise((r) => setTimeout(r, 500));
      
    } catch (err) {
      console.error("Send error:", err.message);
    }
  }
  
  console.log("[Roblox] Sent " + sent + " messages to Discord");
  res.json({ sent: sent });
});

// ─── Start everything ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log("HTTP server running on port " + PORT);
});

// Login to Discord
if (TOKEN) {
  console.log("Logging in to Discord...");
  
  bot.login(TOKEN).catch((err) => {
    console.error("====================================");
    console.error("LOGIN FAILED!");
    console.error("Error: " + err.message);
    console.error("====================================");
    
    if (err.message.includes("token")) {
      console.error("Your token is invalid!");
      console.error("1. Go to https://discord.com/developers/applications");
      console.error("2. Click your app -> Bot -> Reset Token");
      console.error("3. Copy the new token");
      console.error("4. Paste it in Render -> Environment -> DISCORD_TOKEN");
      console.error("5. Redeploy");
    }
  });
} else {
  console.error("Cannot login - no token!");
}

console.log("Startup complete. Waiting for Discord...");
