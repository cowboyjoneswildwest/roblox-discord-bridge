require("dotenv").config();
const express = require("express");
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  WebhookClient,
} = require("discord.js");

// ─── Config ───────────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const BRIDGE_SECRET = process.env.BRIDGE_SECRET;
const PORT = process.env.PORT || 3000;

// ─── Rate Limiting Config ─────────────────────────────────────────────────────
// Roblox HttpService limit: 500 requests/min. We batch on Roblox side.
// Discord API: ~50 messages/second per bot, but we throttle to be safe.
const DISCORD_SEND_COOLDOWN_MS = 600; // min ms between discord sends
const MAX_QUEUE_SIZE = 200;

// ─── State ────────────────────────────────────────────────────────────────────
let discordToRobloxQueue = []; // Messages from Discord → Roblox (polled)
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
  console.log(`[Discord] Logged in as ${client.user.tag}`);
  bridgeChannel = client.channels.cache.get(CHANNEL_ID);
  if (!bridgeChannel) {
    client.channels.fetch(CHANNEL_ID).then((ch) => {
      bridgeChannel = ch;
      console.log(`[Discord] Bridge channel found: #${ch.name}`);
    }).catch(() => {
      console.error("[Discord] Could not find bridge channel!");
    });
  } else {
    console.log(`[Discord] Bridge channel found: #${bridgeChannel.name}`);
  }
});

// Capture Discord messages → queue for Roblox
client.on("messageCreate", (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== CHANNEL_ID) return;

  // Sanitize and truncate
  let content = message.content.replace(/[^\x20-\x7E\n]/g, "").substring(0, 200);
  if (!content.trim()) return;

  const entry = {
    author: message.author.displayName || message.author.username,
    message: content,
    timestamp: Date.now(),
  };

  discordToRobloxQueue.push(entry);

  // Prevent unbounded growth — drop oldest
  if (discordToRobloxQueue.length > MAX_QUEUE_SIZE) {
    discordToRobloxQueue = discordToRobloxQueue.slice(-MAX_QUEUE_SIZE);
  }

  console.log(`[Discord→Roblox] Queued: ${entry.author}: ${content}`);
});

// ─── Throttled Discord Sender ─────────────────────────────────────────────────
function enqueueDiscordMessage(username, content, eventType) {
  if (discordSendQueue.length >= MAX_QUEUE_SIZE) {
    discordSendQueue.shift(); // drop oldest
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
      // If rate limited, wait and re-queue
      if (err.status === 429) {
        const retryAfter = err.retryAfter || 5;
        console.warn(`[Discord] Rate limited, waiting ${retryAfter}s`);
        discordSendQueue.unshift(item); // put it back
        await sleep(retryAfter * 1000);
      }
    }
  }

  processingDiscordQueue = false;
}

async function sendToDiscord(username, content, eventType) {
  if (!bridgeChannel) return;

  if (eventType === "join") {
    const embed = new EmbedBuilder()
      .setColor(0x00ff00)
      .setDescription(`**${escapeMarkdown(username)}** joined the game`);
    await bridgeChannel.send({ embeds: [embed] });
  } else if (eventType === "leave") {
    const embed = new EmbedBuilder()
      .setColor(0xff0000)
      .setDescription(`**${escapeMarkdown(username)}** left the game`);
    await bridgeChannel.send({ embeds: [embed] });
  } else {
    // Regular chat message
    const sanitized = content.substring(0, 1900);
    await bridgeChannel.send(
      `**[Roblox] ${escapeMarkdown(username)}:** ${escapeMarkdown(sanitized)}`
    );
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

// Auth middleware
function authMiddleware(req, res, next) {
  const secret = req.headers["x-bridge-secret"];
  if (secret !== BRIDGE_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

// Health check (Render needs this to keep the service alive)
app.get("/", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ─── Roblox → Discord: Receive batched messages ─────────────────────────────
// Roblox sends a batch of messages every few seconds instead of one-by-one
app.post("/api/roblox-to-discord", authMiddleware, (req, res) => {
  const { messages } = req.body;

  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: "messages must be an array" });
  }

  // Limit batch size
  const batch = messages.slice(0, 20);
  let queued = 0;

  for (const msg of batch) {
    if (!msg.username || (!msg.content && !msg.eventType)) continue;

    const username = String(msg.username).substring(0, 50);
    const content = String(msg.content || "").substring(0, 200);
    const eventType = msg.eventType || "chat"; // "chat", "join", "leave"

    enqueueDiscordMessage(username, content, eventType);
    queued++;
  }

  console.log(`[Roblox→Discord] Received batch of ${queued} messages`);
  res.json({ success: true, queued });
});

// ─── Discord → Roblox: Long-poll endpoint ────────────────────────────────────
// Roblox polls this. We return all pending messages and clear the queue.
// This way Roblox only needs 1 request every few seconds.
app.get("/api/discord-to-roblox", authMiddleware, (req, res) => {
  // Optional: support "since" timestamp to prevent re-delivery
  const since = parseInt(req.query.since) || 0;

  let messages;
  if (since > 0) {
    messages = discordToRobloxQueue.filter((m) => m.timestamp > since);
  } else {
    messages = [...discordToRobloxQueue];
  }

  // Clear delivered messages (only those we're returning)
  if (messages.length > 0) {
    const latestTimestamp = messages[messages.length - 1].timestamp;
    discordToRobloxQueue = discordToRobloxQueue.filter(
      (m) => m.timestamp > latestTimestamp
    );
  }

  // Cap response
  messages = messages.slice(0, 50);

  res.json({
    messages,
    serverTime: Date.now(),
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Server] HTTP server listening on port ${PORT}`);
});

client.login(DISCORD_TOKEN).catch((err) => {
  console.error("[Discord] Login failed:", err.message);
  process.exit(1);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[Server] SIGTERM received, shutting down...");
  client.destroy();
  process.exit(0);
});
