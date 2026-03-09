# 🔗 Roblox-Discord Chat Bridge

A real-time two-way chat bridge between a Roblox game and a Discord channel.
Messages sent in Discord appear in the Roblox chat, and messages sent in
Roblox appear in the Discord channel.

Designed to be hosted on [Render](https://render.com) (free tier compatible).

---

## Features

- **Two-way chat** — Roblox ↔ Discord in real time
- **Join/leave notifications** — Player joins and leaves show in Discord
- **Batched requests** — Stays well under Roblox's 500 req/min HTTP limit
- **Discord rate limit handling** — Automatic backoff on 429 responses
- **Message queue** — No messages dropped during spikes
- **Supports both chat systems** — Legacy Chat and TextChatService
- **Secure** — Secret key authentication on all API requests

---

## Architecture
┌──────────┐ HTTP POST (batched) ┌──────────────┐ Discord API ┌─────────┐
│ Roblox │ ───────────────────────▶ │ Bridge API │ ───────────────▶ │ Discord │
│ Server │ │ (Render) │ │ Channel │
│ │ ◀─────────────────────── │ │ ◀──────────────── │ │
└──────────┘ HTTP GET (polling) └──────────────┘ Message Event └─────────┘

text


---

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- A [Discord Bot](https://discord.com/developers/applications) with Message Content Intent enabled
- A Roblox game with HTTP Requests enabled
- A [Render](https://render.com) account (free tier works)

---

## Setup

### 1. Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** → give it a name
3. Go to **Bot** → click **Reset Token** → copy the token
4. Enable **Message Content Intent** under Privileged Gateway Intents
5. Go to **OAuth2 → URL Generator**
   - Scopes: `bot`
   - Permissions: `Send Messages`, `Read Message History`, `Embed Links`
6. Open the generated URL to invite the bot to your server
7. Right-click the channel you want to bridge → **Copy Channel ID**
   (enable Developer Mode in Discord settings if you don't see this)

### 2. Deploy to Render

1. Fork or push this repo to your GitHub account
2. Go to [Render Dashboard](https://dashboard.render.com)
3. Click **New** → **Web Service**
4. Connect your GitHub repo
5. Configure the service:

   | Setting         | Value         |
   |-----------------|---------------|
   | **Root Directory** | `bot`      |
   | **Runtime**     | `Node`        |
   | **Build Command** | `npm install` |
   | **Start Command** | `npm start`  |

6. Add environment variables under **Environment**:

   | Key                | Value                              |
   |--------------------|------------------------------------|
   | `DISCORD_TOKEN`    | Your bot token                     |
   | `DISCORD_CHANNEL_ID` | Your channel ID                 |
   | `BRIDGE_SECRET`    | A random secret (see below)        |
   | `PORT`             | `3000`                             |

7. Click **Create Web Service**
8. Wait for the deploy to finish — note your URL (e.g. `https://my-bridge.onrender.com`)

#### Generate a secret key

Run this in a terminal:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
