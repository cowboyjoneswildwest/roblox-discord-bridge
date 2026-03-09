require("dotenv").config();
const express = require("express");
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
} = require("discord.js");

// ─── Config ───────────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const BRIDGE_SECRET = process.env.BRIDGE_SECRET;
const PORT = process.env.PORT || 3000;

// ─── Debug: Log config on startup ─────────────────────────────────────────────
console.log("═══════════════════════════════════════════════════════");
console.log("[Debug] Starting Roblox-Discord Bridge");
console.log("═══════════════════════════════════════════════════════");
console.log("[Debug] DISCORD_TOKEN exists:", !!DISCORD_TOKEN);
console.log("[Debug] DISCORD_TOKEN length:", DISCORD_TOKEN ? DISCORD_TOKEN.length : 0);
console.log("[Debug] DISCORD_TOKEN preview:", DISCORD_TOKEN ? DISCORD_TOKEN.substring(0, 20) + "..." : "MISSING");
console.log("[Debug] DISCORD_CHANNEL_ID:", CHANNEL_ID || "MISSING");
console.log("[Debug] BRIDGE_SECRET exists:", !!BRIDGE_SECRET);
console.log("[Debug] BRIDGE_SECRET length:", BRIDGE_SECRET ? BRIDGE_SECRET.length : 0);
console.log("[Debug] PORT:", PORT);
console.log("═══════════════════════════════════════════════════════");

// ─── Rate Limiting Config ─────────────────────────────────────────────────────
const DISCORD_SEND_COOLDOWN_MS = 600;
const MAX_QUEUE_SIZE = 200;

// ─── State ────────────────────────────────────────────────────────────────────
let discordToRobloxQueue = [];
let lastDiscordSend = 0;
let discordSendQueue = [];
let processingDiscordQueue = false;

// ─── Discord Bot ──────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

let bridgeChannel = null;

client.once("ready", () => {
  console.log("═══════════════════════════════════════════════════════");
  console.log(`[Discord] ✅ Logged in as ${client.user.tag}`);
  console.log(`[Discord] Bot ID: ${client.user.id}`);
  console.log(`[Discord] Guilds: ${client.guilds.cache.size}`);
  console.log("═══════════════════════════════════════════════════════");
  
  bridgeChannel = client.channels.cache.get(CHANNEL_ID);
  if (!bridgeChannel) {
    console.log("[Discord] Channel not in cache, fetching...");
    client.channels.fetch(CHANNEL_ID)
      .then((ch) => {
        bridgeChannel = ch;
        console.log(`[Discord] ✅ Bridge channel found: #${ch.name}`);
      })
      .catch((err) => {
        console.error("[Discord] ❌ Could not find bridge channel!");
        console.error("[Discord] Error:", err.message);
        console.error("[Discord] Make sure the bot is in the server and has access to the channel");
      });
  } else {
    console.log(`[Discord] ✅ Bridge channel found: #${bridgeChannel.name}`);
  }
});

client.on("error", (error) => {
  console.error("[Discord] Client error:", error.message);
});

client.on("warn", (warning) => {
  console.warn("[Discord] Warning:", warning);
});

client.on("disconnect", () => {
  console.warn("[Discord] Disconnected!");
});

client.on("reconnecting", () => {
  console.log("[Discord] Reconnecting...");
});

// Capture Discord messages → queue for Roblox
client.on("messageCreate", (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== CHANNEL_ID) return;

  let content = message.content.replace(/[^\x20-\x7E\n]/g, "").substring(0, 200);
  if (!content.trim()) return;

  const entry = {
    author: message.author.displayName || message.author.username,
    message: content,
    timestamp: Date.now(),
  };

  discordToRobloxQueue.push(entry);

  if (discordToRobloxQueue.length > MAX_QUEUE_SIZE) {
    discordToRobloxQueue = discordToRobloxQueue.slice(-MAX_QUEUE_SIZE);
  }

  console.log(`[Discord→Roblox] Queued: ${entry.author}: ${content}`);
});

// ─── Throttled Discord Sender ─────────────────────────────────────────────────
function enqueueDiscordMessage(username, content, eventType) {
  if (discordSendQueue.length >= MAX_QUEUE_SIZE) {
    discordSendQueue.shift();
  }
  discordSendQueue.push({ username, content, eventType });
  processDiscordQueue();
}

async function processDiscordQueue() {
  if (processingDiscordQueue) return;
  processingDiscordQueue = true;

  while (discordSendQueue.length > 0) {
    const now = Date.now();
    const elapsed = now - lastDiscordSend;

    if (elapsed < DISCORD_SEND_COOLDOWN_MS) {
      await sleep(DISCORD_SEND_COOLDOWN_MS - elapsed);
    }

    const item = discordSendQueue.shift();
    if (!item) break;

    try {
      await sendToDiscord(item.username, item.content, item.eventType);
      lastDiscordSend = Date.now();
    } catch (err) {
      console.error("[Discord Send Error]", err.message);
      if (err.status === 429) {
        const retryAfter = err.retryAfter || 5;
        console.warn(`[Discord] Rate limited, waiting ${retryAfter}s`);
        discordSendQueue.unshift(item);
        await sleep(retryAfter * 1000);
      }
    }
  }

  processingDiscordQueue = false;
}

async function sendToDiscord(username, content, eventType) {
  if (!bridgeChannel) {
    console.warn("[Discord] Cannot send - bridge channel not found");
    return;
  }

  if (eventType === "join") {
    const embed = new EmbedBuilder()
      .setColor(0x00ff00)
      .setDescription(`**${escapeMarkdown(username)}** joined the game`);
    await bridgeChannel.send({ embeds: [embed] });
    console.log(`[Roblox→Discord] Sent join notification for ${username}`);
  } else if (eventType === "leave") {
    const embed = new EmbedBuilder()
      .setColor(0xff0000)
      .setDescription(`**${escapeMarkdown(username)}** left the game`);
    await bridgeChannel.send({ embeds: [embed] });
    console.log(`[Roblox→Discord] Sent leave notification for ${username}`);
  } else {
    const sanitized = content.substring(0, 1900);
    await bridgeChannel.send(
      `**[Roblox] ${escapeMarkdown(username)}:** ${escapeMarkdown(sanitized)}`
    );
    console.log(`[Roblox→Discord] Sent message from ${username}`);
  }
}

function escapeMarkdown(text) {
  return text.replace(/([*_~`|\\>])/g, "\\$1");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Express API Server ──────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "1mb" }));

function authMiddleware(req, res, next) {
  const secret = req.headers["x-bridge-secret"];
  if (secret !== BRIDGE_SECRET) {
    console.warn("[API] Auth failed - invalid secret");
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

app.get("/", (req, res) => {
  res.json({ 
    status: "ok", 
    uptime: process.uptime(),
    discord: {
      connected: client.isReady(),
      user: client.user ? client.user.tag : null,
      channelFound: !!bridgeChannel
    }
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/roblox-to-discord", authMiddleware, (req, res) => {
  const { messages } = req.body;

  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: "messages must be an array" });
  }

  const batch = messages.slice(0, 20);
  let queued = 0;

  for (const msg of batch) {
    if (!msg.username || (!msg.content && !msg.eventType)) continue;

    const username = String(msg.username).substring(0, 50);
    const content = String(msg.content || "").substring(0, 200);
    const eventType = msg.eventType || "chat";

    enqueueDiscordMessage(username, content, eventType);
    queued++;
  }

  console.log(`[Roblox→Discord] Received batch of ${queued} messages`);
  res.json({ success: true, queued });
});

app.get("/api/discord-to-roblox", authMiddleware, (req, res) => {
  const since = parseInt(req.query.since) || 0;

  let messages;
  if (since > 0) {
    messages = discordToRobloxQueue.filter((m) => m.timestamp > since);
  } else {
    messages = [...discordToRobloxQueue];
  }

  if (messages.length > 0) {
    const latestTimestamp = messages[messages.length - 1].timestamp;
    discordToRobloxQueue = discordToRobloxQueue.filter(
      (m) => m.timestamp > latestTimestamp
    );
  }

  messages = messages.slice(0, 50);

  res.json({
    messages,
    serverTime: Date.now(),
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Server] ✅ HTTP server listening on port ${PORT}`);
});

// ─── Start Discord Bot ────────────────────────────────────────────────────────
console.log("[Discord] Attempting to login...");

if (!DISCORD_TOKEN) {
  console.error("═══════════════════════════════════════════════════════");
  console.error("[Discord] ❌ DISCORD_TOKEN is not set!");
  console.error("[Discord] Add it to your Render environment variables");
  console.error("═══════════════════════════════════════════════════════");
} else {
  client.login(DISCORD_TOKEN)
    .then(() => {
      console.log("[Discord] ✅ Login promise resolved");
    })
    .catch((err) => {
      console.error("═══════════════════════════════════════════════════════");
      console.error("[Discord] ❌ LOGIN FAILED");
      console.error("[Discord] Error name:", err.name);
      console.error("[Discord] Error message:", err.message);
      console.error("[Discord] Error code:", err.code);
      console.error("═══════════════════════════════════════════════════════");
      
      if (err.message.includes("invalid token")) {
        console.error("[Discord] 👉 Your token is invalid. Get a new one from:");
        console.error("[Discord]    https://discord.com/developers/applications");
        console.error("[Discord]    → Your App → Bot → Reset Token");
      }
      
      if (err.message.includes("disallowed intents")) {
        console.error("[Discord] 👉 Enable intents in Discord Developer Portal:");
        console.error("[Discord]    → Your App → Bot → Privileged Gateway Intents");
        console.error("[Discord]    → Enable: Message Content Intent");
      }
    });
}

// ─── Error Handlers ───────────────────────────────────────────────────────────
process.on("unhandledRejection", (err) => {
  console.error("[UNHANDLED REJECTION]", err);
});

process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err);
});

process.on("SIGTERM", () => {
  console.log("[Server] SIGTERM received, shutting down...");
  client.destroy();
  process.exit(0);
});
