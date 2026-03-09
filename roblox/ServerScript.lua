--[[
    Chat Bridge Server Script
    Place in ServerScriptService
    
    REQUIRED: Enable HttpService in Game Settings → Security
    REQUIRED: Create a RemoteEvent named "ChatBridgeEvent" in ReplicatedStorage
]]

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TextService = game:GetService("TextService")
local Chat = game:GetService("Chat")

-- ─── CONFIGURATION ─────────────────────────────────────────────────────────
local CONFIG = {
    SERVER_URL = "https://your-app-name.onrender.com", -- Your Render URL
    SECRET = "some_long_random_secret_key_here",        -- Must match .env
    
    -- Timing (tuned to avoid Roblox HttpService limits: 500 req/min)
    POLL_INTERVAL = 3,          -- Seconds between polling Discord→Roblox
    SEND_INTERVAL = 2,          -- Seconds between batch sends Roblox→Discord
    RETRY_DELAY = 10,           -- Seconds to wait after an error
    MAX_RETRIES = 3,            -- Max retries per request
    REQUEST_TIMEOUT = 15,       -- Timeout for HTTP requests
    
    -- Queue limits
    MAX_OUTBOUND_QUEUE = 50,    -- Max messages waiting to send to Discord
    MAX_BATCH_SIZE = 10,        -- Max messages per batch send
}

-- ─── SETUP ─────────────────────────────────────────────────────────────────

-- Create RemoteEvent if it doesn't exist
local chatBridgeEvent = ReplicatedStorage:FindFirstChild("ChatBridgeEvent")
if not chatBridgeEvent then
    chatBridgeEvent = Instance.new("RemoteEvent")
    chatBridgeEvent.Name = "ChatBridgeEvent"
    chatBridgeEvent.Parent = ReplicatedStorage
end

-- ─── STATE ─────────────────────────────────────────────────────────────────
local outboundQueue = {}     -- Messages to send to Discord
local lastPollTime = 0       -- Timestamp from server for dedup
local isShuttingDown = false
local httpRequestCount = 0   -- Track requests per minute for safety

-- Reset counter every 60 seconds
task.spawn(function()
    while not isShuttingDown do
        task.wait(60)
        httpRequestCount = 0
    end
end)

-- ─── UTILITY FUNCTIONS ────────────────────────────────────────────────────

local function log(level, ...)
    print(string.format("[ChatBridge][%s]", level), ...)
end

local function canMakeRequest()
    -- Stay well under 500/min limit
    return httpRequestCount < 100
end

local function makeRequest(method, endpoint, body)
    if not canMakeRequest() then
        log("WARN", "Rate limit safety: skipping request")
        return nil, "Rate limited (self-imposed)"
    end
    
    local url = CONFIG.SERVER_URL .. endpoint
    local headers = {
        ["Content-Type"] = "application/json",
        ["x-bridge-secret"] = CONFIG.SECRET,
    }
    
    local requestData = {
        Url = url,
        Method = method,
        Headers = headers,
    }
    
    if body then
        requestData.Body = HttpService:JSONEncode(body)
    end
    
    local success, response
    for attempt = 1, CONFIG.MAX_RETRIES do
        success, response = pcall(function()
            return HttpService:RequestAsync(requestData)
        end)
        
        httpRequestCount = httpRequestCount + 1
        
        if success and response.Success then
            return HttpService:JSONDecode(response.Body), nil
        end
        
        if success and response.StatusCode == 429 then
            log("WARN", "Server rate limited us, waiting...")
            task.wait(CONFIG.RETRY_DELAY)
        elseif success and response.StatusCode == 403 then
            log("ERROR", "Authentication failed! Check your secret key.")
            return nil, "Auth failed"
        elseif not success then
            log("WARN", string.format("Request failed (attempt %d/%d): %s", 
                attempt, CONFIG.MAX_RETRIES, tostring(response)))
            if attempt < CONFIG.MAX_RETRIES then
                task.wait(CONFIG.RETRY_DELAY * attempt)
            end
        else
            log("WARN", string.format("HTTP %d (attempt %d/%d)", 
                response.StatusCode, attempt, CONFIG.MAX_RETRIES))
            if attempt < CONFIG.MAX_RETRIES then
                task.wait(CONFIG.RETRY_DELAY)
            end
        end
    end
    
    return nil, "Max retries exceeded"
end

local function filterText(text, fromPlayerId, toPlayerId)
    local success, result = pcall(function()
        local filtered = TextService:FilterStringAsync(text, fromPlayerId)
        return filtered:GetChatForUserAsync(toPlayerId)
    end)
    
    if success then
        return result
    else
        return "[ filtered ]"
    end
end

local function queueOutbound(username, content, eventType)
    if #outboundQueue >= CONFIG.MAX_OUTBOUND_QUEUE then
        table.remove(outboundQueue, 1) -- Drop oldest
        log("WARN", "Outbound queue full, dropped oldest message")
    end
    
    table.insert(outboundQueue, {
        username = username,
        content = content or "",
        eventType = eventType or "chat",
    })
end

-- ─── CHAT LISTENER ────────────────────────────────────────────────────────

local function onPlayerChat(player, message)
    -- Roblox filters the message for us in the default chat system,
    -- but we get the raw message here. We'll send it and let context handle it.
    -- The message from the Chatted event is already the player's raw input.
    
    local sanitized = string.sub(message, 1, 200)
    
    -- Don't bridge commands
    if string.sub(sanitized, 1, 1) == "/" then
        return
    end
    
    log("INFO", string.format("%s: %s", player.Name, sanitized))
    queueOutbound(player.Name, sanitized, "chat")
end

-- ─── PLAYER CONNECTIONS ───────────────────────────────────────────────────

local function onPlayerAdded(player)
    log("INFO", player.Name .. " joined")
    queueOutbound(player.Name, "", "join")
    
    player.Chatted:Connect(function(message)
        onPlayerChat(player, message)
    end)
end

local function onPlayerRemoving(player)
    log("INFO", player.Name .. " left")
    queueOutbound(player.Name, "", "leave")
end

Players.PlayerAdded:Connect(onPlayerAdded)
Players.PlayerRemoving:Connect(onPlayerRemoving)

-- Handle players already in-game (studio testing)
for _, player in ipairs(Players:GetPlayers()) do
    task.spawn(onPlayerAdded, player)
end

-- ─── OUTBOUND LOOP (Roblox → Discord) ─────────────────────────────────────
-- Batches messages and sends every SEND_INTERVAL seconds

task.spawn(function()
    log("INFO", "Outbound sender started")
    
    while not isShuttingDown do
        task.wait(CONFIG.SEND_INTERVAL)
        
        if #outboundQueue > 0 then
            -- Grab a batch
            local batch = {}
            local count = math.min(#outboundQueue, CONFIG.MAX_BATCH_SIZE)
            
            for i = 1, count do
                table.insert(batch, table.remove(outboundQueue, 1))
            end
            
            log("INFO", string.format("Sending batch of %d messages to Discord", #batch))
            
            local result, err = makeRequest("POST", "/api/roblox-to-discord", {
                messages = batch,
            })
            
            if err then
                log("ERROR", "Failed to send batch: " .. tostring(err))
                -- Re-queue failed messages at the front
                for i = #batch, 1, -1 do
                    table.insert(outboundQueue, 1, batch[i])
                end
                -- Cap queue after re-adding
                while #outboundQueue > CONFIG.MAX_OUTBOUND_QUEUE do
                    table.remove(outboundQueue)
                end
                task.wait(CONFIG.RETRY_DELAY)
            end
        end
    end
end)

-- ─── INBOUND LOOP (Discord → Roblox) ──────────────────────────────────────
-- Polls the server every POLL_INTERVAL seconds

task.spawn(function()
    log("INFO", "Inbound poller started")
    
    -- Small initial delay to let everything initialize
    task.wait(2)
    
    while not isShuttingDown do
        local endpoint = string.format("/api/discord-to-roblox?since=%d", lastPollTime)
        local result, err = makeRequest("GET", endpoint)
        
        if result and result.messages then
            if result.serverTime then
                lastPollTime = result.serverTime
            end
            
            for _, msg in ipairs(result.messages) do
                if msg.author and msg.message and msg.message ~= "" then
                    log("INFO", string.format("[Discord] %s: %s", msg.author, msg.message))
                    
                    -- Fire to all clients
                    chatBridgeEvent:FireAllClients("discord_message", {
                        author = string.sub(tostring(msg.author), 1, 50),
                        message = string.sub(tostring(msg.message), 1, 200),
                    })
                end
            end
            
            if #result.messages > 0 then
                log("INFO", string.format("Delivered %d Discord messages to clients", #result.messages))
            end
        elseif err then
            log("WARN", "Poll failed: " .. tostring(err))
            task.wait(CONFIG.RETRY_DELAY)
        end
        
        task.wait(CONFIG.POLL_INTERVAL)
    end
end)

-- ─── CLEANUP ──────────────────────────────────────────────────────────────

game:BindToClose(function()
    isShuttingDown = true
    log("INFO", "Server shutting down, flushing queue...")
    
    -- Try to send remaining messages
    if #outboundQueue > 0 then
        local batch = {}
        local count = math.min(#outboundQueue, CONFIG.MAX_BATCH_SIZE)
        for i = 1, count do
            table.insert(batch, outboundQueue[i])
        end
        
        pcall(function()
            makeRequest("POST", "/api/roblox-to-discord", {
                messages = batch,
            })
        end)
    end
end)

log("INFO", "Chat Bridge Server Script initialized")
log("INFO", "Server URL: " .. CONFIG.SERVER_URL)
