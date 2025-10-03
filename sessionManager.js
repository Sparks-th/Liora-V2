import fs from "fs";
import path from "path";
import { naruyaizumi, protoType, serialize } from "./lib/simple.js";
import {
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    useMultiFileAuthState,
} from "baileys";
import P from "pino";
import chalk from "chalk";
import { schedule } from "./lib/cron.js";

// Initialize prototype extensions
protoType();
serialize();

// Create sessions directory if it doesn't exist
const SESSIONS_DIR = path.resolve(process.cwd(), "sessions");
if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    console.log(chalk.green("📁 Created sessions directory"));
}

// Connection states for tracking
const CONNECTION_STATES = {
    DISCONNECTED: "disconnected",
    CONNECTING: "connecting",
    CONNECTED: "connected",
    AUTHENTICATED: "authenticated",
    LOGGED_OUT: "logged_out",
    ERROR: "error"
};

class SessionManager {
    constructor() {
        this.sessions = {}; // Map of telegramUserId -> session data
        this.connectionCheckers = new Map(); // Stores interval IDs for connection state monitoring
        this.loadExistingSessions();
    }

    async loadExistingSessions() {
        try {
            // Check for existing session folders and load them
            if (fs.existsSync(SESSIONS_DIR)) {
                const sessionFolders = fs.readdirSync(SESSIONS_DIR).filter(dir => 
                    fs.statSync(path.join(SESSIONS_DIR, dir)).isDirectory()
                );
                
                console.log(chalk.cyan(`📂 Found ${sessionFolders.length} existing session folders`));
                
                // We'll initialize these sessions when requested, not automatically
            }
        } catch (error) {
            console.error("❌ Error loading existing sessions:", error);
        }
    }

    async createSession(telegramUserId, pairingNumber = null, pairingAuth = false) {
        try {
            console.log(chalk.blue(`🔄 Creating new session for Telegram user: ${telegramUserId}`));
            
            // Create user session directory
            const sessionPath = path.join(SESSIONS_DIR, telegramUserId.toString());
            if (!fs.existsSync(sessionPath)) {
                fs.mkdirSync(sessionPath, { recursive: true });
            }
            
            // Initialize session database
            const sessionDb = global.getSessionDB(telegramUserId);
            
            // Set up Baileys auth
            const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
            const { version: baileysVersion } = await fetchLatestBaileysVersion();
            
            const connectionOptions = {
                version: baileysVersion,
                logger: P({ level: "debug" }),
                printQRInTerminal: false, // Ensure QR is NEVER printed in terminal
                qrTimeout: 0, // Set QR timeout to 0 to prevent QR generation
                browser: Browsers.ubuntu("Safari"),
                emitOwnEvents: true,
                markOnlineOnConnect: true,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(
                        state.keys,
                        P().child({ level: "silent", stream: "store" })
                    ),
                },
                // Add connection validation for better state tracking
                connectTimeoutMs: 60000, // Increased timeout for connection
                keepAliveIntervalMs: 15000,
                maxRetries: 10, // Increased retries
                retryRequestDelayMs: 3000, // Increased retry delay
                generateHighQualityLinkPreview: false,
                // Use less aggressive reconnect
                customReconnect: (error) => {
                    // Don't reconnect if it's a logout error
                    if (error?.output?.statusCode === 401) return false;
                    // For 515 errors, use a special reconnect strategy
                    if (error?.output?.statusCode === 515) return 3;
                    // Default reconnect behavior
                    return 2;
                }
            };
            
            // Create WhatsApp connection
            const conn = naruyaizumi(connectionOptions);
            conn.isInit = false;
            conn.sessionUserId = telegramUserId;
            
            // Store session data with additional tracking info
            this.sessions[telegramUserId] = {
                conn,
                sessionPath,
                db: sessionDb,
                pairingNumber,
                pairingAuth,
                createdAt: new Date(),
                startTime: Date.now(),
                connectionState: CONNECTION_STATES.CONNECTING,
                lastStateChange: Date.now(),
                reconnectAttempts: 0,
                lastReconnect: null,
                pairingCode: null,
                pairingCodeExpiry: null,
                saveCreds
            };
            
            // Set up autosave for session database
            schedule(
                `autosave-${telegramUserId}`,
                async () => {
                    try {
                        if (this.sessions[telegramUserId]?.db?.data) {
                            this.sessions[telegramUserId].db.write();
                        }
                    } catch (e) {
                        console.error(`❌ Error saving database for session ${telegramUserId}:`, e);
                    }
                },
                { intervalSeconds: 30 }
            );
            
            // Set up periodic connection state monitoring
            this.startConnectionMonitoring(telegramUserId);
            
            console.log(chalk.green(`✅ Session created for Telegram user: ${telegramUserId}`));
            return this.sessions[telegramUserId];
            
        } catch (error) {
            console.error(`❌ Error creating session for ${telegramUserId}:`, error);
            return null;
        }
    }
    
    startConnectionMonitoring(telegramUserId) {
        // Clear any existing monitoring interval
        if (this.connectionCheckers.has(telegramUserId)) {
            clearInterval(this.connectionCheckers.get(telegramUserId));
        }
        
        // Create new monitoring interval
        const interval = setInterval(() => {
            const session = this.sessions[telegramUserId];
            if (!session) {
                clearInterval(interval);
                this.connectionCheckers.delete(telegramUserId);
                return;
            }
            
            try {
                // Update session state based on connection status
                const conn = session.conn;
                let newState = CONNECTION_STATES.DISCONNECTED;
                
                // More robust and conservative state checking - require multiple criteria
                const wsReady = conn.ws?.readyState;
                const isAuthenticated = !!conn.authState?.creds?.me?.id;
                const hasUser = !!conn.user?.id;
                
                if (wsReady === 1) { // WebSocket OPEN
                    if (isAuthenticated && hasUser) {
                        newState = CONNECTION_STATES.AUTHENTICATED;
                        
                        // Mark the authentication time if not already set
                        if (!session.authenticatedAt) {
                            session.authenticatedAt = Date.now();
                            console.log(chalk.green(`✅ [${telegramUserId}] Authentication confirmed`));
                        }
                    } else {
                        newState = CONNECTION_STATES.CONNECTED;
                    }
                } else if (wsReady === 0) { // WebSocket CONNECTING
                    newState = CONNECTION_STATES.CONNECTING;
                } else if (wsReady === 2 || wsReady === 3) { // WebSocket CLOSING or CLOSED
                    // Only set to disconnected if we've been authenticated before
                    // Otherwise, we're still in the initial connection phase
                    if (session.authenticatedAt) {
                        newState = CONNECTION_STATES.DISCONNECTED;
                    } else {
                        newState = CONNECTION_STATES.CONNECTING; // Still trying to connect
                    }
                }
                
                // If there's a socket error, mark as error state
                if (conn.ws?.error) {
                    newState = CONNECTION_STATES.ERROR;
                }
                
                // Update state if changed - with debounce to avoid flickering states
                if (session.connectionState !== newState) {
                    // Store potential new state
                    if (!session.pendingState) {
                        session.pendingState = {
                            state: newState,
                            since: Date.now()
                        };
                    } else if (session.pendingState.state !== newState) {
                        // If state changed again, reset the timer
                        session.pendingState = {
                            state: newState,
                            since: Date.now()
                        };
                    } else if (Date.now() - session.pendingState.since > 3000) {
                        // Only change state if it's been stable for 3 seconds
                        const oldState = session.connectionState;
                        session.connectionState = newState;
                        session.lastStateChange = Date.now();
                        
                        console.log(chalk.yellow(`📊 [${telegramUserId}] Connection state changed: ${oldState} -> ${newState}`));
                        
                        // Clear pending state
                        session.pendingState = null;
                        
                        // Emit state change event (could be used for notifications)
                        if (this.onStateChange) {
                            this.onStateChange(telegramUserId, oldState, newState);
                        }
                    }
                } else {
                    // Current state matches desired state, clear any pending state
                    session.pendingState = null;
                }
            } catch (error) {
                console.error(`❌ Error monitoring connection for session ${telegramUserId}:`, error);
            }
        }, 2000); // Check every 2 seconds (reduced from 5)
        
        this.connectionCheckers.set(telegramUserId, interval);
    }
    
    async reconnectSession(telegramUserId) {
        const session = this.sessions[telegramUserId];
        if (!session) return false;
        
        try {
            console.log(chalk.yellow(`🔄 Attempting to reconnect session for ${telegramUserId}`));
            
            // Try to close the existing connection first
            try {
                if (session.conn.ws) {
                    session.conn.ws.close();
                }
            } catch (e) {
                console.log(chalk.yellow(`⚠️ Error closing connection for ${telegramUserId}, continuing anyway:`, e.message));
            }
            
            // Update tracking info
            session.reconnectAttempts++;
            session.lastReconnect = Date.now();
            session.connectionState = CONNECTION_STATES.CONNECTING;
            
            // Save credentials again before reconnecting
            if (session.saveCreds && session.authenticatedAt) {
                try {
                    await session.saveCreds();
                    console.log(chalk.green(`✅ [${telegramUserId}] Credentials saved before reconnect`));
                } catch (e) {
                    console.error(chalk.red(`❌ [${telegramUserId}] Failed to save credentials:`, e.message));
                }
            }
            
            // Give connection time to close properly
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Re-create connection - use ev.flush() if available
            try {
                if (session.conn.ev && typeof session.conn.ev.flush === 'function') {
                    await session.conn.ev.flush();
                    console.log(chalk.cyan(`🧹 [${telegramUserId}] Event buffer flushed`));
                }
            } catch (e) {
                console.error(chalk.yellow(`⚠️ Error flushing events for ${telegramUserId}:`, e.message));
            }
            
            console.log(chalk.green(`✅ Reconnection initiated for ${telegramUserId}`));
            return true;
        } catch (error) {
            console.error(`❌ Error reconnecting session ${telegramUserId}:`, error);
            session.connectionState = CONNECTION_STATES.ERROR;
            return false;
        }
    }

    async destroySession(telegramUserId) {
        try {
            if (this.sessions[telegramUserId]) {
                console.log(chalk.yellow(`🗑️ Destroying session for Telegram user: ${telegramUserId}`));
                
                // Save database before closing
                if (this.sessions[telegramUserId].db?.data) {
                    try {
                        this.sessions[telegramUserId].db.write();
                    } catch (e) {
                        console.error(`❌ Error saving database for ${telegramUserId}:`, e);
                    }
                }
                
                // Close WebSocket connection
                try {
                    if (this.sessions[telegramUserId].conn.ws) {
                        this.sessions[telegramUserId].conn.ws.close();
                    }
                } catch (e) {
                    console.error(`❌ Error closing WebSocket for ${telegramUserId}:`, e);
                    // Continue with session destruction despite websocket error
                }
                
                // Remove event listeners
                try {
                    this.sessions[telegramUserId].conn.ev.removeAllListeners();
                } catch (e) {
                    console.error(`❌ Error removing event listeners for ${telegramUserId}:`, e);
                }
                
                // Cancel autosave cron task
                try {
                    if (typeof schedule.cancel === 'function') {
                        schedule.cancel(`autosave-${telegramUserId}`);
                    } else {
                        console.warn(`⚠️ schedule.cancel is not available for session ${telegramUserId}`);
                    }
                } catch (e) {
                    console.error(`❌ Error canceling schedule for ${telegramUserId}:`, e);
                }
                
                // Clear connection monitoring
                try {
                    if (this.connectionCheckers.has(telegramUserId)) {
                        clearInterval(this.connectionCheckers.get(telegramUserId));
                        this.connectionCheckers.delete(telegramUserId);
                    }
                } catch (e) {
                    console.error(`❌ Error clearing connection checker for ${telegramUserId}:`, e);
                }
                
                // Remove session from memory
                delete this.sessions[telegramUserId];
                
                console.log(chalk.green(`✅ Session destroyed for Telegram user: ${telegramUserId}`));
                return true;
            } else {
                console.log(chalk.yellow(`⚠️ No active session found for Telegram user: ${telegramUserId}`));
                return false;
            }
        } catch (error) {
            console.error(`❌ Error destroying session for ${telegramUserId}:`, error);
            return false;
        }
    }

    getSession(telegramUserId) {
        return this.sessions[telegramUserId] || null;
    }

    listSessions() {
        return Object.keys(this.sessions);
    }

    getSessionInfo() {
        return Object.entries(this.sessions).map(([userId, session]) => ({
            userId,
            createdAt: session.createdAt,
            connectionState: session.connectionState,
            uptime: session.startTime ? Math.floor((Date.now() - session.startTime) / 1000) : null,
            reconnectAttempts: session.reconnectAttempts,
            pairingNumber: session.pairingNumber ? 
                `${session.pairingNumber.substring(0, 4)}****${session.pairingNumber.substring(session.pairingNumber.length - 2)}` : 
                null,
            isAuthenticated: !!session.conn.authState?.creds?.me?.id,
            device: session.conn.authState?.creds?.me?.name || "Unknown Device"
        }));
    }

    getSessionStats() {
        const sessions = Object.values(this.sessions);
        const authCount = sessions.filter(s => !!s.conn.authState?.creds?.me?.id).length;
        const connectedCount = sessions.filter(s => s.connectionState === CONNECTION_STATES.CONNECTED || 
                                                s.connectionState === CONNECTION_STATES.AUTHENTICATED).length;
        
        return {
            totalSessions: sessions.length,
            authenticatedSessions: authCount,
            connectedSessions: connectedCount,
            connectionStates: {
                connected: sessions.filter(s => s.connectionState === CONNECTION_STATES.CONNECTED).length,
                authenticated: sessions.filter(s => s.connectionState === CONNECTION_STATES.AUTHENTICATED).length,
                connecting: sessions.filter(s => s.connectionState === CONNECTION_STATES.CONNECTING).length,
                disconnected: sessions.filter(s => s.connectionState === CONNECTION_STATES.DISCONNECTED).length,
                error: sessions.filter(s => s.connectionState === CONNECTION_STATES.ERROR).length,
                loggedOut: sessions.filter(s => s.connectionState === CONNECTION_STATES.LOGGED_OUT).length
            }
        };
    }
}

// Create singleton instance
const sessionManager = new SessionManager();
export default sessionManager;
