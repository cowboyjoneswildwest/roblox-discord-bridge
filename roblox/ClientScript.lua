--[[
    Chat Bridge Client Script
    Place in StarterPlayer → StarterPlayerScripts
    
    Displays Discord messages in the Roblox chat window.
    Works with both Legacy Chat and TextChatService.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Players = game:GetService("Players")
local StarterGui = game:GetService("StarterGui")
local TextChatService = game:GetService("TextChatService")

local player = Players.LocalPlayer

-- Wait for the RemoteEvent
local chatBridgeEvent = ReplicatedStorage:WaitForChild("ChatBridgeEvent", 30)
if not chatBridgeEvent then
    warn("[ChatBridge] Could not find ChatBridgeEvent!")
    return
end

-- ─── Detect Chat System ───────────────────────────────────────────────────

local useTextChatService = false
local generalChannel = nil

-- Check if TextChatService is being used (new chat system)
local success, _ = pcall(function()
    if TextChatService.ChatVersion == Enum.ChatVersion.TextChatService then
        useTextChatService = true
    end
end)

if useTextChatService then
    -- Find or wait for the general channel
    task.spawn(function()
        local channels = TextChatService:WaitForChild("TextChannels", 10)
        if channels then
            generalChannel = channels:WaitForChild("RBXGeneral", 10)
        end
    end)
end

-- ─── Display Functions ────────────────────────────────────────────────────

local function displayMessageLegacy(author, message)
    -- Legacy chat system (SetCore)
    local success, err = pcall(function()
        StarterGui:SetCore("ChatMakeSystemMessage", {
            Text = string.format("[Discord] %s: %s", author, message),
            Color = Color3.fromRGB(114, 137, 218), -- Discord blurple
            Font = Enum.Font.GothamBold,
            TextSize = 14,
        })
    end)
    
    if not success then
        -- Chat might not be ready yet, retry once
        task.wait(2)
        pcall(function()
            StarterGui:SetCore("ChatMakeSystemMessage", {
                Text = string.format("[Discord] %s: %s", author, message),
                Color = Color3.fromRGB(114, 137, 218),
                Font = Enum.Font.GothamBold,
                TextSize = 14,
            })
        end)
    end
end

local function displayMessageNew(author, message)
    -- New TextChatService system
    if generalChannel then
        pcall(function()
            generalChannel:DisplaySystemMessage(
                string.format(
                    '<font color="#7289DA"><b>[Discord] %s:</b></font> %s',
                    author,
                    message
                )
            )
        end)
    else
        -- Fallback to legacy method
        displayMessageLegacy(author, message)
    end
end

-- ─── Message Handler ──────────────────────────────────────────────────────

-- Rate limit display to prevent chat spam on client side
local lastDisplayTime = 0
local DISPLAY_COOLDOWN = 0.3 -- seconds between displayed messages
local displayQueue = {}
local processingDisplay = false

local function processDisplayQueue()
    if processingDisplay then return end
    processingDisplay = true
    
    while #displayQueue > 0 do
        local now = tick()
        local elapsed = now - lastDisplayTime
        
        if elapsed < DISPLAY_COOLDOWN then
            task.wait(DISPLAY_COOLDOWN - elapsed)
        end
        
        local item = table.remove(displayQueue, 1)
        if item then
            if useTextChatService then
                displayMessageNew(item.author, item.message)
            else
                displayMessageLegacy(item.author, item.message)
            end
            lastDisplayTime = tick()
        end
    end
    
    processingDisplay = false
end

chatBridgeEvent.OnClientEvent:Connect(function(eventType, data)
    if eventType == "discord_message" and data then
        local author = tostring(data.author or "Unknown")
        local message = tostring(data.message or "")
        
        if message == "" then return end
        
        -- Cap queue to prevent memory issues
        if #displayQueue > 30 then
            table.remove(displayQueue, 1)
        end
        
        table.insert(displayQueue, {
            author = author,
            message = message,
        })
        
        task.spawn(processDisplayQueue)
    end
end)

-- ─── Wait for chat to be ready (Legacy) ───────────────────────────────────

if not useTextChatService then
    task.spawn(function()
        local attempts = 0
        while attempts < 20 do
            local success = pcall(function()
                StarterGui:SetCore("ChatMakeSystemMessage", {
                    Text = "",
                    Color = Color3.new(1, 1, 1),
                })
            end)
            if success then
                break
            end
            attempts = attempts + 1
            task.wait(1)
        end
    end)
end

print("[ChatBridge] Client script loaded | TextChatService:", useTextChatService)
