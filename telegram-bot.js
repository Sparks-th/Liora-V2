import TelegramBot from "node-telegram-bot-api";
import fs from "fs";
import path from "path";
import chalk from "chalk";
import { EventEmitter } from "events";
import sessionManager from "./sessionManager.js";

// Load Telegram bot token from environment
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8344424790:AAHG8YggeNiQ-v07ahVU5p9c4cHBTXFpPm0";

// If no token is provided, we'll mock the bot for development
const createBot = () => {
    if (!TELEGRAM_TOKEN) {
        console.warn(chalk.yellow("⚠️ TELEGRAM_BOT_TOKEN not set. Running with mock Telegram bot."));
        
        // Create a mock bot that just logs commands
        const mockBot = new EventEmitter();
        mockBot.onText = (regex, callback) => {
            console.log(chalk.blue(`📝 Registered Telegram command handler: ${regex}`));
        };
        mockBot.sendMessage = (chatId, text) => {
            console.log(chalk.blue(`📤 Would send to ${chatId}: ${text}`));
            return Promise.resolve({ message_id: Math.floor(Math.random() * 1000) });
        };
        mockBot.sendPhoto = (chatId, photo, options) => {
            console.log(chalk.blue(`📤 Would send photo to ${chatId} with caption: ${options?.caption || 'No caption'}`));
            return Promise.resolve({ message_id: Math.floor(Math.random() * 1000) });
        };
        return mockBot;
    } else {
        try {
            //clear all sessions folder on startup including session dbs
            fs.rmSync(path.join(process.cwd(), "sessions"), { recursive: true, force: true });
            console.log(chalk.green("🗑️ Cleared existing sessions folder on startup"));

            // Create actual Telegram bot
            console.log(chalk.green("🤖 Initializing Telegram bot with provided token"));
            const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
            
            bot.on("polling_error", (error) => {
                console.error(chalk.red("❌ Telegram polling error:"), error);
            });
            
            return bot;
        } catch (error) {
            console.error(chalk.red("❌ Error initializing Telegram bot:"), error);
            process.exit(1);
        }
    }
};

const bot = createBot();

// Helper function to update pairing status
const updatePairingStatus = async (userId, session, messageId) => {
    try {
        // If session doesn't exist or has no connection, don't update
        if (!session || !session.conn) return;
        
        // Get authentication state
        const isAuthenticated = (
            !!session.conn.authState?.creds?.me?.id &&
            session.conn.user?.id &&
            session.connectionState === "authenticated"
        );
        
        if (isAuthenticated) {
            // Get the actual device name with fallbacks
            const deviceName = session.conn.authState?.creds?.me?.name || 
                session.conn.user?.name || "Unknown";
                
            await bot.editMessageText(
                `✅ *WhatsApp Connected Successfully!*\n\n` +
                `Your WhatsApp is now linked with this bot.\n` +
                `Device: ${deviceName}\n\n` +
                `Use /status to check your connection details.`,
                {
                    chat_id: userId,
                    message_id: messageId,
                    parse_mode: "Markdown"
                }
            );
            
            // Also send a confirmation message
            await bot.sendMessage(
                userId,
                `🎉 *Connection Confirmed!*\n\n` +
                `Your WhatsApp account is now fully connected and ready to use.\n` +
                `Device Name: ${deviceName}\n` +
                `Status: Online & Authenticated\n\n` +
                `You can now use the bot features through WhatsApp!`,
                { parse_mode: "Markdown" }
            );
        }
    } catch (e) {
        console.log("Error updating pairing status:", e.message);
    }
};

// In-memory storage for session requests and timers
const pendingPairings = new Map(); // userId -> { number, timestamp, timer, expiryTime }
const pairingCodeTimers = new Map(); // userId -> { timer, messageId }

// Database of Telegram to WhatsApp mappings
const MAPPING_FILE = path.join(process.cwd(), "telegram-whatsapp-mappings.json");
let userMappings = {};

// Load existing mappings with proper error handling
try {
    if (fs.existsSync(MAPPING_FILE)) {
        const fileContent = fs.readFileSync(MAPPING_FILE, 'utf-8');
        // Only parse if there's actual content
        if (fileContent && fileContent.trim()) {
            userMappings = JSON.parse(fileContent);
            console.log(chalk.green(`📊 Loaded ${Object.keys(userMappings).length} existing Telegram-WhatsApp mappings`));
        } else {
            // If file exists but is empty, initialize with empty object
            fs.writeFileSync(MAPPING_FILE, JSON.stringify({}, null, 2));
            console.log(chalk.yellow("📊 Created empty mapping file"));
        }
    } else {
        // Create the file if it doesn't exist
        fs.writeFileSync(MAPPING_FILE, JSON.stringify({}, null, 2));
        console.log(chalk.yellow("📊 Created new mapping file"));
    }
} catch (error) {
    console.error(chalk.red("❌ Error loading Telegram-WhatsApp mappings:"), error);
    // Ensure we have valid mappings even after error
    userMappings = {};
}

// Save mappings to file with enhanced error handling
const saveMappings = () => {
    try {
        fs.writeFileSync(MAPPING_FILE, JSON.stringify(userMappings, null, 2));
    } catch (error) {
        console.error(chalk.red("❌ Error saving Telegram-WhatsApp mappings:"), error);
    }
};

// Start command
bot.onText(/\/start/, (msg) => {
    const userId = msg.from.id;
    const firstName = msg.from.first_name;
    
    bot.sendMessage(
        userId,
        `👋 Hello ${firstName}! I'm the WhatsApp Session Manager Bot.\n\n` +
        `I can help you create and manage WhatsApp sessions. Here are my commands:\n\n` +
        `🔹 /pair <your_whatsapp_number> - Start pairing process\n` +
        `🔹 /status - Check your WhatsApp session status\n` +
        `🔹 /destroy - Destroy your WhatsApp session\n` +
        `🔹 /help - Show this help message`
    );
});

// Help command
bot.onText(/\/help/, (msg) => {
    const userId = msg.from.id;
    
    bot.sendMessage(
        userId,
        `📚 *Available Commands*\n\n` +
        `🔹 /pair <your_whatsapp_number> - Pair with WhatsApp\n` +
        `🔹 /pairalt <your_whatsapp_number> - Try multiple phone formats for pairing\n` +
        `🔹 /status - Check session status\n` +
        `🔹 /destroy - Destroy your session\n` +
        `🔹 /reconnect - Attempt to reconnect your session\n\n` +
        `Example: /pair 6281234567890`,
        { parse_mode: "Markdown" }
    );
});

// Updated Pair command - Start WhatsApp session pairing with better code handling
bot.onText(/\/pair(?:\s+(.+))?/, async (msg, match) => {
    const userId = msg.from.id.toString();
    const rawPhoneNumber = match[1]?.trim().replace(/[+\s-]/g, "");
    
    if (!rawPhoneNumber) {
        return bot.sendMessage(
            userId,
            "⚠️ Please provide your WhatsApp number after /pair command.\n\nExample: /pair 6281234567890"
        );
    }
    
    // Validate phone number format - basic check for now
    if (!/^\d{10,15}$/.test(rawPhoneNumber)) {
        return bot.sendMessage(
            userId,
            "⚠️ Invalid phone number format. Please use international format without spaces, +, or -.\n\nExample: /pair 6281234567890"
        );
    }
    
    // Properly format the phone number for WhatsApp - ensure it has country code
    const phoneNumber = rawPhoneNumber.startsWith("0") 
        ? rawPhoneNumber.replace(/^0/, "62") // Assuming Indonesian number
        : rawPhoneNumber;
    
    console.log(chalk.blue(`📱 Attempting to pair with phone number: ${phoneNumber}`));
    
    // Check if user already has a session
    if (sessionManager.getSession(userId)) {
        return bot.sendMessage(
            userId,
            "⚠️ You already have an active session. Use /status to check it or /destroy to remove it before creating a new one."
        );
    }
    
    // Cancel any existing pairing timers
    if (pairingCodeTimers.has(userId)) {
        clearTimeout(pairingCodeTimers.get(userId).timer);
        pairingCodeTimers.delete(userId);
    }
    
    // Store the pairing request
    pendingPairings.set(userId, { 
        number: phoneNumber,
        timestamp: Date.now()
    });
    
    const statusMsg = await bot.sendMessage(
        userId,
        "🔄 Creating your WhatsApp session and generating pairing code...",
        { parse_mode: "Markdown" }
    );
    
    try {
        // Create a new WhatsApp session
        const session = await sessionManager.createSession(userId, phoneNumber, true);
        console.log( chalk.yellow(' === DEBUG INFO === '));
        console.log( chalk.yellow(`PHONE NUMBER: ${phoneNumber}`));
        
        if (session) {
            // Update user mappings
            userMappings[userId] = { 
                whatsappNumber: phoneNumber,
                createdAt: new Date().toISOString(),
                lastActive: new Date().toISOString()
            };
            saveMappings();
            
            // Emit session created event
            bot.emit("newSession", userId);
            
            // Wait briefly for pairing code generation
            setTimeout(async () => {
                try {
                    // Generate pairing code if not already present
                    if (!session.pairingCode) {
                        try {
                            console.log(chalk.yellow(`🔑 Requesting pairing code for ${phoneNumber}...`));
                            // Make sure phone number starts with country code without + symbol
                            const formattedNumber = phoneNumber.replace(/^\+/, "");
                            const code = await session.conn.requestPairingCode(formattedNumber);
                            console.log(chalk.green(`✅ Received raw pairing code: ${code}`));
                            
                            // Format code with hyphens for better readability if it doesn't have them already
                            session.pairingCode = code?.includes("-") 
                                ? code 
                                : code?.match(/.{1,4}/g)?.join("-") || code;
                                
                            console.log(chalk.green(`✅ Formatted pairing code: ${session.pairingCode}`));
                        } catch (error) {
                            console.error(`Error generating pairing code for ${userId}:`, error);
                            return bot.editMessageText(
                                "❌ Failed to generate pairing code. Please try again with /pair command.",
                                {
                                    chat_id: userId,
                                    message_id: statusMsg.message_id
                                }
                            );
                        }
                    }

                    // Set expiry time (60 seconds)
                    const expiryTime = Date.now() + 60000;
                    session.pairingCodeExpiry = expiryTime;
                    
                    // Format time remaining
                    const timeRemaining = Math.round((expiryTime - Date.now()) / 1000);
                    
                    // Send the pairing code with countdown
                    const codeMessage = await bot.editMessageText(
                        `📱 *WhatsApp Pairing Code*\n\n` +
                        `Your pairing code: \`${session.pairingCode}\`\n\n` +
                        `⏳ This code expires in *${timeRemaining} seconds*\n\n` +
                        `*How to pair:*\n` +
                        `1. Open WhatsApp on your phone\n` +
                        `2. Go to Settings > Linked Devices > Link a Device\n` +
                        `3. Enter the code above when prompted\n\n` +
                        `Waiting for you to enter the code...`,
                        {
                            chat_id: userId,
                            message_id: statusMsg.message_id,
                            parse_mode: "Markdown"
                        }
                    );
                    
                    // Set up countdown timer
                    let remainingSeconds = 60;
                    const countdownTimer = setInterval(async () => {
                        remainingSeconds -= 5;
                        
                        // Proper authentication check - use multiple criteria for accurate detection
                        const isAuthenticated = (
                            !!session.conn.authState?.creds?.me?.id &&
                            session.conn.user?.id &&
                            session.connectionState === "authenticated"
                        );
                        
                        // Update message every 5 seconds with new countdown
                        if (remainingSeconds > 0 && !isAuthenticated) {
                            try {
                                await bot.editMessageText(
                                    `📱 *WhatsApp Pairing Code*\n\n` +
                                    `Your pairing code: \`${session.pairingCode}\`\n\n` +
                                    `⏳ This code expires in *${remainingSeconds} seconds*\n\n` +
                                    `*How to pair:*\n` +
                                    `1. Open WhatsApp on your phone\n` +
                                    `2. Go to Settings > Linked Devices > Link a Device\n` +
                                    `3. Enter the code above when prompted\n\n` +
                                    `Waiting for you to enter the code...`,
                                    {
                                        chat_id: userId,
                                        message_id: codeMessage.message_id,
                                        parse_mode: "Markdown"
                                    }
                                );
                            } catch (e) {
                                console.log("Error updating countdown:", e.message);
                            }
                        } else {
                            // Clear interval when time's up or connection successful
                            clearInterval(countdownTimer);
                            
                            // Re-check authentication status to be certain with all criteria
                            const finalAuthCheck = (
                                !!session.conn.authState?.creds?.me?.id &&
                                session.conn.user?.id &&
                                session.connectionState === "authenticated"
                            );
                            
                            if (finalAuthCheck) {
                                // Connected successfully - double check the connection is fully established
                                updatePairingStatus(userId, session, codeMessage.message_id);
                            } else if (remainingSeconds <= 0) {
                                // Code expired
                                session.pairingCode = null;
                                try {
                                    await bot.editMessageText(
                                        `⌛ *Pairing code expired*\n\n` +
                                        `The pairing code has expired. Use /pair command to generate a new code.`,
                                        {
                                            chat_id: userId,
                                            message_id: codeMessage.message_id,
                                            parse_mode: "Markdown"
                                        }
                                    );
                                } catch (e) {
                                    console.log("Error updating expiry message:", e.message);
                                }
                            }
                            
                            // Remove timer reference
                            pairingCodeTimers.delete(userId);
                        }
                    }, 5000); // Update every 5 seconds
                    
                    // Store timer reference
                    pairingCodeTimers.set(userId, { 
                        timer: countdownTimer,
                        messageId: codeMessage.message_id
                    });
                    
                    // Set up separate, more thorough connection check with delay
                    // Only declare success after multiple successful checks
                    let successfulChecks = 0;
                    const connectionCheckTimer = setInterval(async () => {
                        // Most comprehensive authentication check
                        const isFullyAuthenticated = (
                            !!session.conn.authState?.creds?.me?.id &&
                            session.conn.user?.id &&
                            session.conn.ws?.readyState === 1 &&
                            session.connectionState === "authenticated"
                        );
                        
                        if (isFullyAuthenticated) {
                            successfulChecks++;
                            
                            // Only consider authenticated after multiple successful checks
                            if (successfulChecks >= 3) {
                                clearInterval(connectionCheckTimer);
                                clearInterval(countdownTimer);
                                
                                try {
                                    // Get actual device name with fallbacks
                                    const deviceName = session.conn.authState?.creds?.me?.name || 
                                        session.conn.user?.name || "Unknown";
                                        
                                    await bot.editMessageText(
                                        `✅ *WhatsApp Connected Successfully!*\n\n` +
                                        `Your WhatsApp is now linked with this bot.\n` +
                                        `Device: ${deviceName}\n\n` +
                                        `Use /status to check your connection details.`,
                                        {
                                            chat_id: userId,
                                            message_id: codeMessage.message_id,
                                            parse_mode: "Markdown"
                                        }
                                    );
                                } catch (e) {
                                    console.log("Error updating connection success message:", e.message);
                                }
                            }
                        } else {
                            // Reset counter if any check fails
                            successfulChecks = 0;
                        }
                    }, 3000); // Check connection every 3 seconds
                    
                    // Auto-clear connection check after 65 seconds
                    setTimeout(() => {
                        clearInterval(connectionCheckTimer);
                    }, 65000);
                    
                } catch (error) {
                    console.error(`Error sending pairing code for user ${userId}:`, error);
                    await bot.editMessageText(
                        "❌ An error occurred while generating your pairing code. Please try again with /pair command.",
                        {
                            chat_id: userId,
                            message_id: statusMsg.message_id
                        }
                    );
                }
            }, 2000);
            
        } else {
            await bot.editMessageText(
                "❌ Failed to create WhatsApp session. Please try again later.",
                {
                    chat_id: userId,
                    message_id: statusMsg.message_id
                }
            );
        }
    } catch (error) {
        console.error(`Error creating session for user ${userId}:`, error);
        await bot.editMessageText(
            "❌ An error occurred while creating your session. Please try again later.",
            {
                chat_id: userId,
                message_id: statusMsg.message_id
            }
        );
    }
});

// Alternative pairing command that tries different phone formats
bot.onText(/\/pairalt(?:\s+(.+))?/, async (msg, match) => {
    const userId = msg.from.id.toString();
    let rawPhoneNumber = match[1]?.trim().replace(/[+\s-]/g, "");
    
    if (!rawPhoneNumber) {
        return bot.sendMessage(
            userId,
            "⚠️ Please provide your WhatsApp number after /pairalt command.\n\nExample: /pairalt 6281234567890"
        );
    }
    
    // Validate phone number format - basic check for now
    if (!/^\d{10,15}$/.test(rawPhoneNumber)) {
        return bot.sendMessage(
            userId,
            "⚠️ Invalid phone number format. Please use international format without spaces, +, or -.\n\nExample: /pairalt 6281234567890"
        );
    }
    
    // Check if user already has a session
    if (sessionManager.getSession(userId)) {
        return bot.sendMessage(
            userId,
            "⚠️ You already have an active session. Use /status to check it or /destroy to remove it before creating a new one."
        );
    }
    
    const statusMsg = await bot.sendMessage(
        userId,
        "🔄 Creating your WhatsApp session and testing different phone formats...",
        { parse_mode: "Markdown" }
    );
    
    try {
        // Try different phone number formats
        const phoneFormats = [];
        
        // Format 1: As provided
        phoneFormats.push(rawPhoneNumber);
        
        // Format 2: With "+" prefix
        phoneFormats.push("+" + rawPhoneNumber);
        
        // Format 3: If number starts with "0", replace with country code
        if (rawPhoneNumber.startsWith("0")) {
            phoneFormats.push(rawPhoneNumber.replace(/^0/, "62"));  // Assuming Indonesia
        }
        
        // Format 4: If doesn't start with country code, add default
        if (!/^(1|7|2|3|4|5|6|8|9)/.test(rawPhoneNumber)) {
            phoneFormats.push("62" + rawPhoneNumber);  // Assuming Indonesia
        }
        
        console.log(chalk.blue(`📱 Will try these phone formats: ${phoneFormats.join(", ")}`));
        
        // Use the first format to create the session
        const phoneNumber = phoneFormats[0];
        const session = await sessionManager.createSession(userId, phoneNumber, true);
        
        if (session) {
            // Update user mappings
            userMappings[userId] = { 
                whatsappNumber: phoneNumber,
                createdAt: new Date().toISOString(),
                lastActive: new Date().toISOString()
            };
            saveMappings();
            
            // Emit session created event
            bot.emit("newSession", userId);
            
            await bot.editMessageText(
                "⏳ Session created. Now trying different phone formats for pairing code...",
                {
                    chat_id: userId,
                    message_id: statusMsg.message_id
                }
            );
            
            // Try each format for pairing code
            let successfulCode = null;
            let codeMessage = null;
            
            for (const format of phoneFormats) {
                if (successfulCode) break;
                
                try {
                    console.log(chalk.yellow(`🔑 Trying pairing code with format: ${format}`));
                    const code = await session.conn.requestPairingCode(format);
                    console.log(chalk.green(`✅ Received raw pairing code: ${code}`));
                    
                    // Format code with hyphens for better readability
                    const formattedCode = code?.includes("-") 
                        ? code 
                        : code?.match(/.{1,4}/g)?.join("-") || code;
                    
                    session.pairingCode = formattedCode;
                    session.pairingNumber = format;
                    
                    // Update the message with the new code
                    codeMessage = await bot.editMessageText(
                        `📱 *WhatsApp Pairing Code*\n\n` +
                        `Your pairing code: \`${formattedCode}\`\n\n` +
                        `⚙️ Generated using phone format: ${format}\n\n` +
                        `*How to pair:*\n` +
                        `1. Open WhatsApp on your phone\n` +
                        `2. Go to Settings > Linked Devices > Link a Device\n` +
                        `3. Enter the code above when prompted\n\n` +
                        `If this code doesn't work, please wait as we try other formats.`,
                        {
                            chat_id: userId,
                            message_id: statusMsg.message_id,
                            parse_mode: "Markdown"
                        }
                    );
                    
                    // Wait a moment to see if connection happens
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    
                    // If authenticated, mark as successful
                    if (session.conn.authState?.creds?.me?.id) {
                        successfulCode = format;
                        break;
                    }
                } catch (error) {
                    console.error(`Error with phone format ${format}:`, error);
                    // Continue to next format
                }
            }
            
            // Final message
            if (successfulCode) {
                await bot.editMessageText(
                    `✅ *WhatsApp Connected Successfully!*\n\n` +
                    `Your WhatsApp is now linked with this bot.\n` +
                    `Working phone format: ${successfulCode}\n` +
                    `Device: ${session.conn.authState?.creds?.me?.name || "Unknown"}\n\n` +
                    `Use /status to check your connection details.`,
                    {
                        chat_id: userId,
                        message_id: statusMsg.message_id,
                        parse_mode: "Markdown"
                    }
                );
            } else {
                await bot.editMessageText(
                    `⚠️ *Attempted All Phone Formats*\n\n` +
                    `We tried all phone formats but couldn't establish a connection.\n\n` +
                    `Last pairing code: \`${session.pairingCode || "None"}\`\n\n` +
                    `Please try using this code in WhatsApp, or try the /pair command with a different phone number format.`,
                    {
                        chat_id: userId,
                        message_id: statusMsg.message_id,
                        parse_mode: "Markdown"
                    }
                );
            }
            
            // Start connection monitoring and checking
            let successfulChecks = 0;
            const connectionCheckTimer = setInterval(async () => {
                const isFullyAuthenticated = (
                    !!session.conn.authState?.creds?.me?.id &&
                    session.conn.user?.id &&
                    session.conn.ws?.readyState === 1
                );
                
                if (isFullyAuthenticated) {
                    successfulChecks++;
                    
                    if (successfulChecks >= 3) {
                        clearInterval(connectionCheckTimer);
                        
                        try {
                            const deviceName = session.conn.authState?.creds?.me?.name || "Unknown";
                            
                            await bot.sendMessage(
                                userId,
                                `🎉 *WhatsApp Connection Confirmed!*\n\n` +
                                `Your device "${deviceName}" is now connected to the bot.\n` +
                                `Working phone format: ${session.pairingNumber}\n\n` +
                                `Use /status to see more details.`,
                                { parse_mode: "Markdown" }
                            );
                        } catch (e) {
                            console.log("Error sending confirmation:", e.message);
                        }
                    }
                } else {
                    successfulChecks = 0;
                }
            }, 3000);
            
            // Auto-clear connection check after 2 minutes
            setTimeout(() => {
                clearInterval(connectionCheckTimer);
            }, 120000);
            
        } else {
            await bot.editMessageText(
                "❌ Failed to create WhatsApp session. Please try again later.",
                {
                    chat_id: userId,
                    message_id: statusMsg.message_id
                }
            );
        }
    } catch (error) {
        console.error(`Error with alternative pairing for user ${userId}:`, error);
        await bot.editMessageText(
            "❌ An error occurred while trying alternative pairing methods. Please try again later.",
            {
                chat_id: userId,
                message_id: statusMsg.message_id
            }
        );
    }
});

// Status command with better connection state display
bot.onText(/\/status/, async (msg) => {
    const userId = msg.from.id.toString();
    const session = sessionManager.getSession(userId);
    
    if (!session) {
        return bot.sendMessage(
            userId,
            "⚠️ You don't have an active WhatsApp session. Use /pair to create one."
        );
    }
    
    const conn = session.conn;
    const isAuthenticated = !!conn.authState?.creds?.me?.id;
    const deviceName = conn.authState?.creds?.me?.name || "Unknown Device";
    const phoneNumber = session.pairingNumber || "Not provided";
    const createdAt = session.createdAt.toLocaleString();
    
    // Get detailed connection state
    const connectionState = conn.ws?.readyState;
    let connectionStatus = "Unknown";
    let statusEmoji = "❓";
    
    if (connectionState === 0) {
        connectionStatus = "Connecting";
        statusEmoji = "🔄";
    } else if (connectionState === 1) {
        connectionStatus = "Connected";
        statusEmoji = "✅";
    } else if (connectionState === 2) {
        connectionStatus = "Disconnecting";
        statusEmoji = "⚠️";
    } else if (connectionState === 3) {
        connectionStatus = "Disconnected";
        statusEmoji = "❌";
    }
    
    // Check if device is actually connected to WhatsApp
    if (isAuthenticated) {
        if (conn.user?.id) {
            connectionStatus = "Online & Authenticated";
            statusEmoji = "✅";
        } else {
            connectionStatus = "Authenticated but Offline";
            statusEmoji = "🟠";
        }
    }
    
    // Get uptime if available
    let uptime = "N/A";
    if (session.startTime) {
        const uptimeMs = Date.now() - session.startTime;
        const uptimeSec = Math.floor(uptimeMs / 1000);
        const days = Math.floor(uptimeSec / 86400);
        const hours = Math.floor((uptimeSec % 86400) / 3600);
        const minutes = Math.floor((uptimeSec % 3600) / 60);
        const seconds = uptimeSec % 60;
        
        uptime = [];
        if (days > 0) uptime.push(`${days}d`);
        if (hours > 0) uptime.push(`${hours}h`);
        if (minutes > 0) uptime.push(`${minutes}m`);
        if (seconds > 0 || uptime.length === 0) uptime.push(`${seconds}s`);
        uptime = uptime.join(' ');
    }
    
    bot.sendMessage(
        userId,
        `📱 *WhatsApp Session Status*\n\n` +
        `🔹 Session ID: \`${userId}\`\n` +
        `🔹 Status: ${statusEmoji} ${connectionStatus}\n` +
        `🔹 Authenticated: ${isAuthenticated ? '✅ Yes' : '❌ No'}\n` +
        `🔹 Phone Number: ${phoneNumber}\n` +
        `🔹 Created: ${createdAt}\n` +
        `🔹 Uptime: ${uptime}\n` +
        `🔹 Device: ${deviceName}\n\n` +
        `${!isAuthenticated ? 
            'Your session is not connected to WhatsApp. Use /pair to connect.' : 
            'Your session is active and connected to WhatsApp.'}`,
        { parse_mode: "Markdown" }
    );
});

// Reconnect command
bot.onText(/\/reconnect/, async (msg) => {
    const userId = msg.from.id.toString();
    const session = sessionManager.getSession(userId);
    
    if (!session) {
        return bot.sendMessage(
            userId,
            "⚠️ You don't have an active WhatsApp session. Use /pair to create one."
        );
    }
    
    const statusMsg = await bot.sendMessage(
        userId,
        "🔄 Attempting to reconnect your WhatsApp session..."
    );
    
    try {
        // Force reconnection
        const success = await sessionManager.reconnectSession(userId);
        
        if (success) {
            await bot.editMessageText(
                "✅ Reconnection initiated. Use /status to check connection status.",
                {
                    chat_id: userId,
                    message_id: statusMsg.message_id
                }
            );
        } else {
            await bot.editMessageText(
                "⚠️ Session may need re-pairing. Use /pair to create a new pairing code.",
                {
                    chat_id: userId,
                    message_id: statusMsg.message_id
                }
            );
        }
    } catch (error) {
        console.error(`Error reconnecting session for user ${userId}:`, error);
        await bot.editMessageText(
            "❌ An error occurred while reconnecting. Please try again or use /pair to create a new session.",
            {
                chat_id: userId,
                message_id: statusMsg.message_id
            }
        );
    }
});

// Destroy command
bot.onText(/\/destroy/, async (msg) => {
    const userId = msg.from.id.toString();
    
    if (!sessionManager.getSession(userId)) {
        return bot.sendMessage(
            userId,
            "⚠️ You don't have an active WhatsApp session to destroy."
        );
    }
    
    // Cancel any existing pairing timers
    if (pairingCodeTimers.has(userId)) {
        clearTimeout(pairingCodeTimers.get(userId).timer);
        pairingCodeTimers.delete(userId);
    }
    
    const statusMsg = await bot.sendMessage(
        userId,
        "🔄 Destroying your WhatsApp session..."
    );
    
    try {
        const success = await sessionManager.destroySession(userId);
        
        if (success) {
            // Update user mappings
            if (userMappings[userId]) {
                delete userMappings[userId];
                saveMappings();
            }
            
            await bot.editMessageText(
                "✅ Your WhatsApp session has been successfully destroyed.",
                {
                    chat_id: userId,
                    message_id: statusMsg.message_id
                }
            );
        } else {
            await bot.editMessageText(
                "❌ Failed to destroy your WhatsApp session. Please try again.",
                {
                    chat_id: userId,
                    message_id: statusMsg.message_id
                }
            );
        }
    } catch (error) {
        console.error(`Error destroying session for user ${userId}:`, error);
        await bot.editMessageText(
            "❌ An error occurred while destroying your session. Please try again later.",
            {
                chat_id: userId,
                message_id: statusMsg.message_id
            }
        );
    }
});

// Admin commands
const ADMIN_IDS = (process.env.TELEGRAM_ADMIN_IDS || "7988239466")
    .split(",")
    .map(id => id.trim())
    .filter(id => id);

// Admin command - List all sessions
bot.onText(/\/admin_sessions/, (msg) => {
    const userId = msg.from.id.toString();
    
    // Check if user is admin
    if (!ADMIN_IDS.includes(userId)) {
        return bot.sendMessage(userId, "⚠️ You are not authorized to use admin commands.");
    }
    
    const sessions = sessionManager.getSessionInfo();
    const stats = sessionManager.getSessionStats();
    
    if (sessions.length === 0) {
        return bot.sendMessage(userId, "ℹ️ No active sessions found.");
    }
    
    let message = `📊 *Session Statistics*\n` +
                 `Total Sessions: ${stats.totalSessions}\n` +
                 `Authenticated: ${stats.authenticatedSessions}\n\n` +
                 `📱 *Active Sessions*\n\n`;
                 
    sessions.forEach((session, i) => {
        message += `${i+1}. ID: \`${session.userId}\`\n` +
                  `   Status: ${session.isAuthenticated ? '✅ Connected' : '❌ Not Connected'}\n` +
                  `   Device: ${session.device}\n` +
                  `   Created: ${session.createdAt.toLocaleString()}\n\n`;
    });
    
    bot.sendMessage(userId, message, { parse_mode: "Markdown" });
});

// Admin command - Destroy specific session
bot.onText(/\/admin_destroy (.+)/, async (msg, match) => {
    const userId = msg.from.id.toString();
    const targetId = match[1].trim();
    
    // Check if user is admin
    if (!ADMIN_IDS.includes(userId)) {
        return bot.sendMessage(userId, "⚠️ You are not authorized to use admin commands.");
    }
    
    if (!sessionManager.getSession(targetId)) {
        return bot.sendMessage(userId, `⚠️ No active session found for user ID: ${targetId}`);
    }
    
    try {
        const success = await sessionManager.destroySession(targetId);
        
        if (success) {
            // Update user mappings
            if (userMappings[targetId]) {
                delete userMappings[targetId];
                saveMappings();
            }
            
            bot.sendMessage(userId, `✅ Successfully destroyed session for user ID: ${targetId}`);
        } else {
            bot.sendMessage(userId, `❌ Failed to destroy session for user ID: ${targetId}`);
        }
    } catch (error) {
        console.error(`Error in admin_destroy for target ${targetId}:`, error);
        bot.sendMessage(userId, `❌ Error destroying session: ${error.message}`);
    }
});

// Admin command - Debug pairing for a user
bot.onText(/\/admin_debug_pair (.+) (.+)/, async (msg, match) => {
    const userId = msg.from.id.toString();
    
    // Check if user is admin
    if (!ADMIN_IDS.includes(userId)) {
        return bot.sendMessage(userId, "⚠️ You are not authorized to use admin commands.");
    }
    
    const targetId = match[1].trim();
    const phoneNumber = match[2].trim().replace(/[+\s-]/g, "");
    
    // Check if phone number format is valid
    if (!/^\d{10,15}$/.test(phoneNumber)) {
        return bot.sendMessage(userId, "⚠️ Invalid phone number format. Example: 6281234567890");
    }
    
    const statusMsg = await bot.sendMessage(userId, "🔄 Attempting to debug pairing process...");
    
    try {
        // Check if session exists, if not create it
        let session = sessionManager.getSession(targetId);
        if (!session) {
            session = await sessionManager.createSession(targetId, phoneNumber, true);
            if (!session) {
                return bot.editMessageText(
                    "❌ Failed to create session for debugging.",
                    {
                        chat_id: userId,
                        message_id: statusMsg.message_id
                    }
                );
            }
            bot.emit("newSession", targetId);
        }
        
        // Get session info
        const sessionInfo = {
            userId: targetId,
            pairingNumber: session.pairingNumber,
            connectionState: session.connectionState,
            authenticated: !!session.conn.authState?.creds?.me?.id,
            wsState: session.conn.ws?.readyState,
            device: session.conn.authState?.creds?.me?.name || "Unknown"
        };
        
        // Try to generate a pairing code
        let pairingResult;
        try {
            console.log(chalk.blue(`🔍 Admin requesting debug pairing code for ${phoneNumber}`));
            const code = await session.conn.requestPairingCode(phoneNumber);
            pairingResult = {
                success: true,
                code: code,
                formattedCode: code?.match(/.{1,4}/g)?.join("-") || code
            };
            console.log(chalk.green(`✅ Debug pairing code generated: ${pairingResult.formattedCode}`));
        } catch (error) {
            pairingResult = {
                success: false,
                error: error.message || String(error)
            };
            console.error("Pairing code generation error:", error);
        }
        
        // Send detailed debug info
        const debugInfo = `🔍 *Pairing Debug Information*\n\n` +
            `👤 User ID: \`${sessionInfo.userId}\`\n` +
            `📱 Phone: \`${session.pairingNumber || phoneNumber}\`\n` +
            `🔌 Connection: \`${sessionInfo.connectionState}\`\n` +
            `🔐 Authenticated: \`${sessionInfo.authenticated}\`\n` +
            `🌐 WebSocket State: \`${sessionInfo.wsState}\`\n` +
            `📟 Device: \`${sessionInfo.device}\`\n\n` +
            `📝 *Pairing Code Generation:*\n` +
            (pairingResult.success ? 
                `✅ Success\n📟 Code: \`${pairingResult.formattedCode}\`\n📟 Raw: \`${pairingResult.code}\`` : 
                `❌ Failed\n⚠️ Error: \`${pairingResult.error}\``);
        
        await bot.editMessageText(
            debugInfo,
            {
                chat_id: userId,
                message_id: statusMsg.message_id,
                parse_mode: "Markdown"
            }
        );
        
    } catch (error) {
        console.error(`Error in admin_debug_pair:`, error);
        await bot.editMessageText(
            `❌ Error debugging pairing: ${error.message || String(error)}`,
            {
                chat_id: userId,
                message_id: statusMsg.message_id
            }
        );
    }
});

// Add session state change monitoring
sessionManager.onStateChange = async (telegramUserId, oldState, newState) => {
    try {
        // Get any active pairing timer for this user
        const pairingTimer = pairingCodeTimers.get(telegramUserId);
        
        const session = sessionManager.getSession(telegramUserId);
        if (!session) return; // No session exists
        
        // If authentication state changed to authenticated, update the message
        if (newState === "authenticated" && oldState !== "authenticated") {
            if (pairingTimer && pairingTimer.messageId) {
                updatePairingStatus(telegramUserId, session, pairingTimer.messageId);
            } else {
                // If no active pairing timer, just send a new message
                const deviceName = session.conn.authState?.creds?.me?.name || "Unknown";
                bot.sendMessage(
                    telegramUserId,
                    `✅ *WhatsApp Connected Successfully!*\n\n` +
                    `Your WhatsApp is now linked with this bot.\n` +
                    `Device: ${deviceName}\n\n` +
                    `Use /status to check your connection details.`,
                    { parse_mode: "Markdown" }
                );
            }
        } 
        // If connection was lost after authentication
        else if (newState === "disconnected" && oldState === "authenticated") {
            bot.sendMessage(
                telegramUserId,
                `⚠️ *Connection Lost*\n\nYour WhatsApp connection was interrupted. Use /status to check current state or /reconnect to attempt reconnection.`,
                { parse_mode: "Markdown" }
            );
        }
    } catch (error) {
        console.error(`Error in state change handler:`, error);
    }
};

// Export the bot so it can be used in other modules
export default bot;