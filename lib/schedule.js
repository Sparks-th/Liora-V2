import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { schedule } from "./cron.js";
import sessionManager from "../sessionManager.js";
import fetch from "node-fetch";
import telegramBot from "../telegram-bot.js"; // Added import for Telegram bot

let count = 0;
let clearTmpScheduled = false;

async function clearTmp() {
    const tmp = [path.join(os.tmpdir(), "tmp")];
    const filename = [];
    
    await Promise.allSettled(
        tmp.map(async (dir) => {
            const files = await fs.readdir(dir).catch(() => []);
            return Promise.allSettled(
                files.map(async (file) => {
                    filename.push(file);
                    return await fs.unlink(path.join(dir, file)).catch(() => {});
                })
            );
        })
    );
    
    console.log("✓ Successfully cleared tmp folder");
    return filename;
}

async function checkGempa() {
    try {
        const res = await fetch(
            "https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json"
        );
        
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        
        const json = await res.json();
        const data = json.Infogempa.gempa;
        const { Tanggal, Jam, Coordinates, Magnitude, Kedalaman, Wilayah, Potensi } = data;
        
        // Format the data for comparison
        const dateTime = `${Tanggal} ${Jam}`;
        
        // Process for each session instead of using global conn
        const sessions = Object.values(sessionManager.sessions);
        
        if (sessions.length > 0) {
            // Check each session's database for earthquake notifications
            for (const session of sessions) {
                try {
                    if (!session.db?.data) continue;
                    
                    const { bots, chats } = session.db.data;
                    
                    if (bots && bots.gempaDateTime === dateTime) continue;
                    
                    bots.gempaDateTime = dateTime;
                    
                    // Find all chat groups that have earthquake notifications enabled
                    const notifGroups = Object.entries(chats)
                        .filter(([_, chat]) => chat.notifgempa && chat.gempaDateTime !== dateTime)
                        .map(([id, _]) => id);
                    
                    // Send notifications to each group
                    for (const id of notifGroups) {
                        try {
                            const chat = chats[id];
                            if (!chat) continue;
                            
                            chat.gempaDateTime = dateTime;
                            
                            const text = `🌋 *GEMPA BUMI TERKINI*
📆 Tanggal: ${Tanggal}
⏰ Jam: ${Jam} WIB
📍 Koordinat: ${Coordinates}
💢 Kekuatan: ${Magnitude} SR
🌊 Kedalaman: ${Kedalaman}
📍 Wilayah: ${Wilayah}
⚠️ Potensi: ${Potensi}`;
                            
                            await session.conn.sendMessage(id, { text });
                        } catch (err) {
                            console.error(`Error sending earthquake notification to ${id}:`, err);
                        }
                    }
                    
                    // Save changes to database
                    session.db.write();
                } catch (error) {
                    console.error(`Error processing gempa for session:`, error);
                }
            }
        }
    } catch (error) {
        console.error("Error fetching earthquake data:", error);
    }
}

async function resetCommand() {
    // Process for each session instead of using global conn
    const sessions = Object.values(sessionManager.sessions);
    
    if (sessions.length > 0) {
        for (const session of sessions) {
            try {
                if (!session.db?.data) continue;
                
                const { users, chats } = session.db.data;
                
                // Reset user command counters
                for (const user in users) {
                    if (users[user]) {
                        users[user].command = 0;
                        users[user].cmdLimitMsg = 0;
                    }
                }
                
                // Reset group member command counters
                for (const group in chats) {
                    if (chats[group] && chats[group].member) {
                        for (const member in chats[group].member) {
                            if (chats[group].member[member]) {
                                chats[group].member[member].command = 0;
                            }
                        }
                    }
                }
                
                session.db.write();
                console.log(`✓ Successfully reset command limit for session ${session.conn.sessionUserId}`);
            } catch (error) {
                console.error(`Error resetting commands for session:`, error);
            }
        }
    }
}

// Add a new function to check for newly authenticated sessions
async function checkAuthenticationStatus() {
    try {
        const sessions = Object.entries(sessionManager.sessions);
        
        for (const [userId, session] of sessions) {
            // Check for sessions that just got authenticated
            if (session.connectionState === "authenticated" && 
                session.authenticatedAt && 
                !session.authNotified && 
                (Date.now() - session.authenticatedAt) < 10000) { // Within 10 seconds of auth
                
                // Mark as notified
                session.authNotified = true;
                
                // Get device name with fallbacks
                const deviceName = session.conn.authState?.creds?.me?.name || 
                                   session.conn.user?.name || 
                                   "Unknown Device";
                
                console.log(chalk.green(`✅ [${userId}] Authentication confirmed for device: ${deviceName}`));
                
                // Send notification to Telegram user
                try {
                    await telegramBot.sendMessage(
                        userId,
                        `✅ *Authentication Successful!*\n\n` +
                        `Your WhatsApp is now fully authenticated and connected.\n` +
                        `Device: ${deviceName}\n\n` +
                        `Your session is ready to use.`,
                        { parse_mode: "Markdown" }
                    );
                } catch (e) {
                    console.error(`Error sending authentication notification to Telegram user ${userId}:`, e);
                }
            }
        }
    } catch (error) {
        console.error("Error checking authentication status:", error);
    }
}

// Export the new function
export { clearTmp, checkGempa, resetCommand, checkAuthenticationStatus };
