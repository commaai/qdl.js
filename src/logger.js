/**
 * @enum {number}
 */
export const LogLevel = {
  SILENT: 0,
  ERROR: 1,
  WARN: 2,
  INFO: 3,
  DEBUG: 4
};

export class Logger {
  /**
   * @param {string} name
   * @param {number} [level=LogLevel.INFO]
   */
  constructor(name, level = LogLevel.INFO) {
    this.name = name;
    this.level = level;
    // Cache the prefix string
    this.prefix = name ? `[${name}] ` : "";
    
    // Device message deduplication state
    this.deviceState = {
      lastMessage: "",
      lastLogLevel: LogLevel.INFO,
      count: 0,
      timeout: null,
      debounceMs: 100 // Wait this many ms before showing duplicates
    };
  }

  /**
   * @param {number} level
   */
  setLevel(level) {
    this.level = level;
  }

  /**
   * @param {...any} args
   */
  debug(...args) {
    if (this.level >= LogLevel.DEBUG) {
      console.debug(this.prefix, ...args);
    }
  }

  /**
   * @param {...any} args
   */
  info(...args) {
    if (this.level >= LogLevel.INFO) {
      console.info(this.prefix, ...args);
    }
  }

  /**
   * @param {...any} args
   */
  warn(...args) {
    if (this.level >= LogLevel.WARN) {
      console.warn(this.prefix, ...args);
    }
  }

  /**
   * @param {...any} args
   */
  error(...args) {
    if (this.level >= LogLevel.ERROR) {
      console.error(this.prefix, ...args);
    }
  }

  /**
   * Process and potentially display a device message
   * @param {string} message - Raw message from device
   */
  deviceMessage(message) {
    if (this.level < LogLevel.INFO) return;
    
    // Extract message content and determine log level
    let formattedMessage = "";
    let logLevel = LogLevel.INFO;
    
    if (message.startsWith("ERROR:")) {
      formattedMessage = message.substring(6).trim();
      logLevel = LogLevel.ERROR;
    } else if (message.startsWith("INFO:")) {
      formattedMessage = message.substring(5).trim();
    } else {
      formattedMessage = message;
    }
    
    // Handle duplicate messages
    const state = this.deviceState;
    
    // Clear any pending timeout
    if (state.timeout) {
      clearTimeout(state.timeout);
      state.timeout = null;
    }
    
    // If this is a new message or a different message
    if (formattedMessage !== state.lastMessage) {
      // Print accumulated count if needed
      this.#printPendingDeviceDuplicates();
      
      // Store the new message
      state.lastMessage = formattedMessage;
      state.lastLogLevel = logLevel;
      state.count = 1;
      
      // Output the message immediately
      this.#printDeviceMessage(formattedMessage, logLevel);
    } else {
      // It's a duplicate, increment counter
      state.count++;
      
      // Schedule a timeout to print the count after a short delay
      state.timeout = setTimeout(() => {
        this.#printPendingDeviceDuplicates();
      }, state.debounceMs);
    }
  }
  
  /**
   * Print a device message with appropriate log level
   * @private
   */
  #printDeviceMessage(message, logLevel) {
    if ((logLevel === LogLevel.ERROR && this.level >= LogLevel.ERROR) || 
        this.level >= LogLevel.INFO) {
      const logMethod = logLevel === LogLevel.ERROR ? console.error : console.info;
      logMethod(`[Device] ${message}`);
    }
  }
  
  /**
   * Print a message showing the count of duplicates if any are pending
   * @private
   */
  #printPendingDeviceDuplicates() {
    const state = this.deviceState;
    if (state.count > 1) {
      const logMethod = state.lastLogLevel === LogLevel.ERROR ? console.error : console.info;
      logMethod(`[Device] Last message repeated ${state.count - 1} times`);
      state.count = 1; // Reset to 1 since we've handled all but the most recent
    }
  }
  
  /**
   * Flush any pending duplicate message counts and clear timeouts
   */
  flushDeviceMessages() {
    const state = this.deviceState;
    
    // Clear any pending timeout
    if (state.timeout) {
      clearTimeout(state.timeout);
      state.timeout = null;
    }
    
    // Print any pending counts
    this.#printPendingDeviceDuplicates();
  }
  
  /**
   * Clean up resources (e.g., timeouts) used by this logger
   */
  dispose() {
    this.flushDeviceMessages();
  }
}

/**
 * @returns {number}
 */
function getGlobalLogLevel() {
  const envLevel = typeof process !== 'undefined' && process.env?.QDL_LOG_LEVEL;
  if (envLevel) {
    const level = Number.parseInt(envLevel, 10);
    if (!Number.isNaN(level) && level >= 0 && level <= 4) {
      return level;
    }
    
    const namedLevels = {
      'silent': LogLevel.SILENT,
      'error': LogLevel.ERROR,
      'warn': LogLevel.WARN,
      'info': LogLevel.INFO,
      'debug': LogLevel.DEBUG
    };
    const normalizedLevel = envLevel.toLowerCase();
    if (normalizedLevel in namedLevels) {
      return namedLevels[normalizedLevel];
    }
  }
  
  return LogLevel.INFO;
}

export const globalLogLevel = getGlobalLogLevel();

/**
 * @param {string} name
 * @param {number} [level]
 * @returns {Logger}
 */
export function createLogger(name, level = globalLogLevel) {
  return new Logger(name, level);
}