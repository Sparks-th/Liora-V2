/* global conn */
import path, { join } from "path";
import { existsSync, readFileSync, watch } from "fs";
import syntaxerror from "syntax-error";
import { format } from "util";
import { schedule } from "./cron.js";
import chalk from "chalk";
import { DisconnectReason } from "baileys";
import { checkGempa, clearTmp, resetCommand, checkAuthenticationStatus } from "./schedule.js";
import sessionManager from "../sessionManager.js";

// Connection states for better tracking
const CONNECTION_STATES = {
    DISCONNECTED: "disconnected",
    CONNECTING: "connecting",
    CONNECTED: "connected",
    AUTHENTICATED: "authenticated",
    LOGGED_OUT: "logged_out",
    ERROR: "error"
};

async function connectionUpdateHandler(update) {
    // 'this' refers to the specific WhatsApp connection instance
    const conn = this;
    const telegramUserId = this.sessionUserId;
    const session = sessionManager.getSession(telegramUserId);
    if (!session) return;

    const { 
        receivedPendingNotifications, 
        connection, 
        lastDisconnect, 
        isOnline, 
        isNewLogin,
        qr  // We'll ignore this but keep reference for logging
    } = update;
    
    // Log all connection updates for debugging
    console.log(chalk.yellow(`📊 [${telegramUserId}] Connection update: ${JSON.stringify({
        connection,
        isNewLogin: !!isNewLogin,
        isOnline: !!isOnline,
        receivedPendingNotifications: !!receivedPendingNotifications,
        hasQR: !!qr,
        errorCode: lastDisconnect?.error?.output?.statusCode,
        errorReason: lastDisconnect?.error?.output?.payload?.error
    })}`));
    
    // If we receive a QR, log it but don't process it - we're using pairing codes only
    if (qr) {
        console.log(chalk.yellow(`⚠️ [${telegramUserId}] QR received but ignored - system using pairing codes only`));
    }
    
    // Update session connection state
    let newState = session.connectionState;
    
    // Handle new login event - this is the most reliable authentication indicator
    if (isNewLogin) {
        conn.isInit = true;
        newState = CONNECTION_STATES.AUTHENTICATED;
        session.startTime = Date.now(); // Reset uptime counter on new login
        session.authenticatedAt = Date.now(); // Set authentication timestamp
        console.log(chalk.green.bold(`🔐 [${telegramUserId}] New login detected - session authenticated`));
        
        // Save last authentication device name
        if (conn.authState?.creds?.me?.name) {
            session.lastAuthDevice = conn.authState.creds.me.name;
        }
        
        // We need to save credentials immediately after authentication
        if (session.saveCreds) {
            try {
                await session.saveCreds();
                console.log(chalk.green(`✅ [${telegramUserId}] Authentication credentials saved`));
            } catch (e) {
                console.error(chalk.red(`❌ [${telegramUserId}] Failed to save auth credentials:`, e));
            }
        }
    }
    
    // Handle connecting state
    if (connection === "connecting") {
        // Only change to connecting if not authenticated yet
        if (!session.authenticatedAt) {
            newState = CONNECTION_STATES.CONNECTING;
            console.log(chalk.yellow.bold(`🚀 [${telegramUserId}] Connecting to WhatsApp...`));
        }
    }
    
    // Handle open connection - but be conservative about authentication status
    if (connection === "open") {
        console.log(chalk.cyan.bold(`⚡ [${telegramUserId}] Connected to WhatsApp successfully`));
        
        // Set to connected initially
        newState = CONNECTION_STATES.CONNECTED;
        
        // Only mark as authenticated when we're sure
        if (conn.authState?.creds?.me?.id && conn.user?.id) {
            newState = CONNECTION_STATES.AUTHENTICATED;
            console.log(chalk.green.bold(`✅ [${telegramUserId}] Session authenticated as ${conn.authState?.creds?.me?.name || 'Unknown'}`));
            
            // Track authentication time if not already set
            if (!session.authenticatedAt) {
                session.authenticatedAt = Date.now();
            }
        }
    }

    // Online status doesn't affect connection state - device might be offline but session still authenticated
    if (isOnline === false) {
        console.log(chalk.redBright.bold(`🔴 [${telegramUserId}] Connection status: Offline`));
    }

    if (receivedPendingNotifications) {
        console.log(chalk.cyan.bold(`📩 [${telegramUserId}] Status: Waiting for messages`));
        // This is a good sign of active connection
        if (session.authenticatedAt) {
            newState = CONNECTION_STATES.AUTHENTICATED;
        }
    }

    // Handle connection close
    if (connection === "close") {
        console.log(chalk.redBright.bold(`⚠️ [${telegramUserId}] Connection closed`));
        
        // Get error code and reason
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.output?.payload?.error;
        
        console.log(chalk.yellow(`📊 [${telegramUserId}] Disconnect reason: ${reason || 'Unknown'} (${statusCode || 'No code'})`));
        
        // If logged out, remove session
        if (statusCode === DisconnectReason.loggedOut) {
            newState = CONNECTION_STATES.LOGGED_OUT;
            console.log(chalk.red.bold(`🔒 [${telegramUserId}] Device logged out, destroying session`));
            await sessionManager.destroySession(telegramUserId);
        } 
        // Handle specific error codes
        else if (statusCode === 515) {
            // Error 515 is common after authentication - usually a temporary error
            // Don't change state if we're authenticated, just attempt reconnect
            console.log(chalk.yellow(`⚠️ [${telegramUserId}] Error 515 detected - normal after authentication, reconnecting...`));
            
            // Save credentials again to ensure they're properly stored
            if (session.saveCreds && session.authenticatedAt) {
                try {
                    await session.saveCreds();
                    console.log(chalk.green(`✅ [${telegramUserId}] Credentials saved before reconnection`));
                } catch (e) {
                    console.error(chalk.red(`❌ [${telegramUserId}] Failed to save credentials before reconnect:`, e));
                }
            }
            
            // Increment reconnection attempts
            session.reconnectAttempts = (session.reconnectAttempts || 0) + 1;
            session.lastReconnect = Date.now();
            
            // Let's wait a moment before reconnecting to prevent rapid reconnection loops
            setTimeout(async () => {
                console.log(chalk.yellow.bold(`🔄 [${telegramUserId}] Attempting to reconnect after Error 515`));
                if (global.reloadHandler) {
                    try {
                        await global.reloadHandler(true, telegramUserId);
                    } catch (error) {
                        console.error(`Error reloading handler after Error 515 for ${telegramUserId}:`, error);
                    }
                }
            }, 2000);
        }
        // For other disconnections
        else if (statusCode !== DisconnectReason.loggedOut) {
            // Only mark as disconnected if previously authenticated
            if (session.authenticatedAt) {
                newState = CONNECTION_STATES.DISCONNECTED;
            }
            
            console.log(chalk.yellow.bold(`🔄 [${telegramUserId}] Attempting to reconnect`));
            
            // Increment reconnection attempts
            session.reconnectAttempts = (session.reconnectAttempts || 0) + 1;
            session.lastReconnect = Date.now();
            
            // Handle reconnection with global handler
            if (global.reloadHandler) {
                try {
                    await global.reloadHandler(true, telegramUserId);
                } catch (error) {
                    console.error(`Error reloading handler for ${telegramUserId}:`, error);
                    newState = CONNECTION_STATES.ERROR;
                }
            }
        }
    }
    
    // Update connection state in session using debounce logic for stability
    if (session.connectionState !== newState) {
        // Store the requested state change with timestamp
        if (!session.pendingState) {
            session.pendingState = {
                state: newState,
                since: Date.now()
            };
            // Log the pending change
            console.log(chalk.blue(`⏳ [${telegramUserId}] Pending state change: ${session.connectionState} -> ${newState}`));
        } 
        // If we get multiple different updates, take the newest one
        else if (session.pendingState.state !== newState) {
            session.pendingState = {
                state: newState,
                since: Date.now()
            };
            // Log the updated pending change
            console.log(chalk.blue(`⏳ [${telegramUserId}] Updated pending state: ${session.connectionState} -> ${newState}`));
        }
        // If state has been stable for at least 2 seconds, apply it
        else if (Date.now() - session.pendingState.since > 2000) {
            const oldState = session.connectionState;
            session.connectionState = newState;
            session.lastStateChange = Date.now();
            session.pendingState = null; // Clear pending state
            
            console.log(chalk.yellow(`📊 [${telegramUserId}] Connection state changed: ${oldState} -> ${newState}`));
        }
    } else {
        // If current state matches target state, clear any pending changes
        session.pendingState = null;
    }

    // Update timestamp
    global.timestamp.connect = new Date();

    // Load session's database if not loaded
    if (session && session.db && session.db.data == null) {
        session.db.read();
    }
}

async function initReload(conn, pluginFolder, getAllPlugins) {
    // 'conn' is a specific WhatsApp connection instance
    const telegramUserId = conn.sessionUserId || "global";
    const pluginFilter = (filename) => /\.js$/.test(filename);

    // Initialize global plugins container if not exists
    if (!global.plugins) global.plugins = {};

    async function filesInit() {
        let success = 0;
        let failed = 0;
        for (let filepath of getAllPlugins(pluginFolder)) {
            let filename = path.relative(pluginFolder, filepath);
            try {
                let file = global.__filename(filepath);
                const module = await import(file);
                global.plugins[filename] = module.default || module;
                success++;
            } catch (error) {
                console.error(`❌ [${telegramUserId}] Error loading plugin ${filename}:`, error);
                delete global.plugins[filename];
                failed++;
            }
        }
        conn.logger.info(`🍩 [${telegramUserId}] Total plugins loaded: ${success}, failed: ${failed}`);
    }

    await filesInit().catch(console.error);

    // Only set up reload functionality if not already defined
    if (!global.reload) {
        global.reload = async (_ev, filename) => {
            if (pluginFilter(filename)) {
                let dir = global.__filename(join(pluginFolder, filename), true);
                if (filename in global.plugins) {
                    if (existsSync(dir)) conn.logger.info(`🍰 Reloading plugin '${filename}'`);
                    else {
                        conn.logger.warn(`🍪 Plugin '${filename}' has been removed`);
                        return delete global.plugins[filename];
                    }
                } else conn.logger.info(`🧁 Loading new plugin: '${filename}'`);
                let err = syntaxerror(readFileSync(dir), filename, {
                    sourceType: "module",
                    allowAwaitOutsideFunction: true,
                });
                if (err) {
                    conn.logger.error(
                        [
                            `🍬 Plugin Error: '${filename}'`,
                            `🍫 Message: ${err.message}`,
                            `🍩 Line: ${err.line}, Column: ${err.column}`,
                            `🍓 ${err.annotated}`,
                        ].join("\n")
                    );
                    return;
                }
                try {
                    const module = await import(`${global.__filename(dir)}?update=${Date.now()}`);
                    global.plugins[filename] = module.default || module;
                } catch (e) {
                    conn.logger.error(`🍪 Error while loading plugin '${filename}'\n${format(e)}`);
                } finally {
                    global.plugins = Object.fromEntries(
                        Object.entries(global.plugins).sort(([a], [b]) => a.localeCompare(b))
                    );
                }
            }
        };

        Object.freeze(global.reload);
    }

    // Set up file watching for this session
    watch(pluginFolder, { recursive: true }, global.reload);
}

function initCron() {
    // Global cron tasks (not session-specific)
    schedule(
        "reset",
        async () => {
            await resetCommand();
            await clearTmp();
        },
        { cron: "0 0 * * *" }
    );

    schedule(
        "feeds",
        async () => {
            await checkGempa();
        },
        { intervalSeconds: 30 }
    );
    
    // Add authentication status check at shorter interval
    schedule(
        "auth-check",
        async () => {
            await checkAuthenticationStatus();
        },
        { intervalSeconds: 3 }
    );
}

export { connectionUpdateHandler, initReload, initCron };
