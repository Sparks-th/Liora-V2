/* global conn */
process.on("uncaughtException", console.error);
process.on("unhandledRejection", console.error);

import "./config.js";
import "./global.js";
import sessionManager from "./sessionManager.js";
import telegramBot from "./telegram-bot.js";
import { readdirSync, statSync } from "fs";
import { join } from "path";
import chalk from "chalk";
import { initReload, initCron, connectionUpdateHandler } from "./lib/connection.js";

console.log(chalk.cyan.bold(`
╭────────────────────────────────────╮
│ 🚀  Multi-Session WhatsApp Bot   🚀
│ ─────────────────────────────────
│ 📅  Date : ${new Date().toLocaleDateString("en-US", { weekday: "long", day: "2-digit", month: "long", year: "numeric" })}
│ 🌐  System : ${process.platform} CPU: ${process.arch}
╰────────────────────────────────────╯
`));

// Make sessions accessible globally
global.sessions = sessionManager.sessions;

// Function to initialize a session's plugins and handlers
async function initializeSession(telegramUserId) {
    const session = sessionManager.getSession(telegramUserId);
    if (!session) {
        console.log(chalk.yellow(`⚠️ Cannot initialize session for ${telegramUserId}: Session not found`));
        return false;
    }

    const conn = session.conn;
    conn.isInit = false;

    console.log(chalk.blue(`🔄 Initializing handlers for session: ${telegramUserId}`));

    // Load handlers for this session
    let handler = await import("./handler.js");

    // Bind handlers to this specific connection
    conn.handler = handler.handler.bind(conn);
    conn.participantsUpdate = handler.participantsUpdate.bind(conn);
    conn.onDelete = handler.deleteUpdate.bind(conn);
    conn.connectionUpdate = connectionUpdateHandler.bind(conn);
    conn.credsUpdate = session.saveCreds.bind(conn);

    // Session default messages
    conn.spromote = "@user sekarang admin!";
    conn.sdemote = "@user sekarang bukan admin!";
    conn.welcome = "Hallo @user Selamat datang di @subject\n\n@desc";
    conn.bye = "Selamat tinggal @user";
    conn.sRevoke = "Link group telah diubah ke \n@revoke";

    // Register event listeners for this connection
    conn.ev.on("messages.upsert", conn.handler);
    conn.ev.on("group-participants.update", conn.participantsUpdate);
    conn.ev.on("message.delete", conn.onDelete);
    conn.ev.on("connection.update", conn.connectionUpdate);
    conn.ev.on("creds.update", conn.credsUpdate);

    // Initialize plugins for this session
    const pluginFolder = global.__dirname(
        join(global.__dirname(import.meta.url), "./plugins/index")
    );

    function getAllPlugins(dir) {
        let results = [];
        for (let file of readdirSync(dir)) {
            let filepath = join(dir, file);
            let stat = statSync(filepath);
            if (stat && stat.isDirectory()) {
                results = results.concat(getAllPlugins(filepath));
            } else if (/\.js$/.test(file)) {
                results.push(filepath);
            }
        }
        return results;
    }

    // Initialize plugins and cron jobs
    await initReload(conn, pluginFolder, getAllPlugins);
    
    console.log(chalk.green(`✅ Session ${telegramUserId} initialized successfully`));
    return true;
}

// Global reload handler for backward compatibility
global.reloadHandler = async function (restartConn, telegramUserId) {
    // If telegramUserId provided, reload specific session
    if (telegramUserId) {
        const session = sessionManager.getSession(telegramUserId);
        if (!session) return false;
        
        try {
            await initializeSession(telegramUserId);
            return true;
        } catch (error) {
            console.error(`Error reloading handler for session ${telegramUserId}:`, error);
            return false;
        }
    } 
    // Otherwise reload all sessions (legacy behavior)
    else {
        const sessions = sessionManager.listSessions();
        for (const id of sessions) {
            try {
                await initializeSession(id);
            } catch (error) {
                console.error(`Error reloading handler for session ${id}:`, error);
            }
        }
        return true;
    }
};

// Initialize global cron jobs (not session-specific)
initCron();

// Listen for new sessions from Telegram bot
telegramBot.on("newSession", async (telegramUserId) => {
    console.log(chalk.blue(`📱 New session created for Telegram user: ${telegramUserId}`));
    await initializeSession(telegramUserId);
});

// Log startup completion
console.log(chalk.green("✅ Multi-session WhatsApp bot started successfully"));
console.log(chalk.blue("🔄 Waiting for session creation via Telegram bot..."));
