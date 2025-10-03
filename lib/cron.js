import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { setTimeout, setInterval, clearTimeout, clearInterval } from 'timers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let cronNative;
try {
    cronNative = require(path.join(__dirname, "../build/Release/cron.node"));
} catch {
    try {
        cronNative = require(path.join(__dirname, "../build/Debug/cron.node"));
    } catch {
        throw new Error("Cron addon belum terbuild.");
    }
}

// Storage for our scheduled tasks
const scheduledTasks = new Map();

/**
 * Schedule a task to run at a specified interval or cron pattern
 * @param {string} name - Unique name for this task
 * @param {Function} callback - Function to execute
 * @param {Object} options - Scheduling options
 * @param {string} [options.cron] - Cron pattern (e.g., "0 0 * * *")
 * @param {number} [options.intervalSeconds] - Run every X seconds
 */
const schedule = (name, callback, options = {}) => {
    // Clear any existing task with the same name
    if (scheduledTasks.has(name)) {
        const task = scheduledTasks.get(name);
        if (task.type === 'interval') {
            clearInterval(task.id);
        } else {
            clearTimeout(task.id);
        }
        scheduledTasks.delete(name);
    }
    
    // Handle interval-based scheduling
    if (options.intervalSeconds) {
        const id = setInterval(() => {
            try {
                callback();
            } catch (error) {
                console.error(`Error in scheduled task "${name}":`, error);
            }
        }, options.intervalSeconds * 1000);
        
        scheduledTasks.set(name, { id, type: 'interval' });
        return id;
    }
    
    // Handle cron-based scheduling (simplified)
    if (options.cron) {
        // Basic cron implementation - this could be expanded with a proper cron library
        const [minute, hour, dayMonth, month, dayWeek] = options.cron.split(' ');
        
        // Very simple daily task at specific hour/minute
        const now = new Date();
        const nextRun = new Date();
        nextRun.setHours(parseInt(hour) || 0);
        nextRun.setMinutes(parseInt(minute) || 0);
        nextRun.setSeconds(0);
        
        if (nextRun <= now) {
            // If the time already passed today, schedule for tomorrow
            nextRun.setDate(nextRun.getDate() + 1);
        }
        
        const delay = nextRun.getTime() - now.getTime();
        
        const id = setTimeout(() => {
            try {
                callback();
                // Re-schedule for the next day
                schedule(name, callback, options);
            } catch (error) {
                console.error(`Error in scheduled task "${name}":`, error);
            }
        }, delay);
        
        scheduledTasks.set(name, { id, type: 'timeout' });
        return id;
    }
};

/**
 * Cancel a scheduled task
 * @param {string} name - Name of the task to cancel
 */
schedule.cancel = (name) => {
    if (scheduledTasks.has(name)) {
        const task = scheduledTasks.get(name);
        if (task.type === 'interval') {
            clearInterval(task.id);
        } else {
            clearTimeout(task.id);
        }
        scheduledTasks.delete(name);
        return true;
    }
    return false;
};

/**
 * Get list of all scheduled tasks
 * @returns {string[]} - Array of task names
 */
schedule.list = () => {
    return Array.from(scheduledTasks.keys());
};

class CronJob {
    constructor(name, handle) {
        this._name = name;
        this._handle = handle;
        if (this._handle?.start) {
            this._handle.start();
        }
    }

    stop() {
        if (this._handle?.stop) {
            this._handle.stop();
            this._handle = null;
            jobs.delete(this._name);
        }
    }

    isRunning() {
        return this._handle?.isRunning?.() ?? false;
    }

    secondsToNext() {
        return this._handle?.secondsToNext?.() ?? -1;
    }
}

export { schedule, CronJob };
