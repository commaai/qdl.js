/**
 * @enum {number}
 */
export const LogLevel = {
  SILENT: 0,
  ERROR: 1,
  WARN: 2,
  INFO: 3,
  DEBUG: 4,
};

export class Logger {
  /**
   * @param {string} name
   * @param {number} [level=LogLevel.INFO]
   */
  constructor(name, level = LogLevel.INFO) {
    this.name = name;
    this.level = level;
    this.prefix = name ? `[${name}] ` : "";

    // Device message deduplication state
    this.deviceState = {
      lastMessage: "",
      lastLogLevel: LogLevel.INFO,
      count: 0,
      timeout: null,
      debounceMs: 100, // Wait this many ms before showing duplicates
    };
  }

  /**
   * @param {LogLevel} level
   */
  setLevel(level) {
    this.level = level;
  }

  debug(...args) {
    if (this.level < LogLevel.DEBUG) return;
    if (this.prefix) {
      console.debug(this.prefix, ...args);
    } else {
      console.debug(...args);
    }
  }

  info(...args) {
    if (this.level < LogLevel.INFO) return;
    if (this.prefix) {
      console.info(this.prefix, ...args);
    } else {
      console.info(...args);
    }
  }

  warn(...args) {
    if (this.level < LogLevel.WARN) return;
    if (this.prefix) {
      console.warn(this.prefix, ...args);
    } else {
      console.warn(...args);
    }
  }

  error(...args) {
    if (this.level < LogLevel.ERROR) return;
    if (this.prefix) {
      console.error(this.prefix, ...args);
    } else {
      console.error(...args);
    }
  }

  /**
   * Process and potentially display a device message
   * @param {string} message - Raw message from device
   */
  deviceMessage(message) {
    if (this.level < LogLevel.INFO) return;

    let formattedMessage;
    let logLevel = LogLevel.INFO;
    if (message.startsWith("ERROR:")) {
      formattedMessage = message.substring(6).trim();
      logLevel = LogLevel.ERROR;
    } else if (message.startsWith("INFO:")) {
      formattedMessage = message.substring(5).trim();
    } else {
      formattedMessage = message;
    }

    const state = this.deviceState;
    if (state.timeout) {
      clearTimeout(state.timeout);
      state.timeout = null;
    }

    if (formattedMessage !== state.lastMessage) {
      this.#printPendingDeviceDuplicates();
      state.lastMessage = formattedMessage;
      state.lastLogLevel = logLevel;
      state.count = 1;
      this.#printDeviceMessage(formattedMessage, logLevel);
    } else {
      state.count++;
      state.timeout = setTimeout(() => {
        this.#printPendingDeviceDuplicates();
      }, state.debounceMs);
    }
  }

  /**
   * Print a device message with appropriate log level
   * @param {string} message
   * @param {LogLevel} logLevel
   * @private
   */
  #printDeviceMessage(message, logLevel) {
    if (this.level < logLevel) return;
    const logMethod = logLevel === LogLevel.ERROR ? console.error : console.info;
    logMethod(`[Device] ${message}`);
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
    if (state.timeout) {
      clearTimeout(state.timeout);
      state.timeout = null;
    }
    this.#printPendingDeviceDuplicates();
  }
}

/**
 * @returns {number}
 */
function getGlobalLogLevel() {
  const envLevel = typeof process !== "undefined" && process.env?.QDL_LOG_LEVEL;
  if (envLevel) {
    const level = Number.parseInt(envLevel, 10);
    if (!Number.isNaN(level) && level >= 0 && level <= 4) {
      return level;
    }

    const namedLevels = {
      "silent": LogLevel.SILENT,
      "error": LogLevel.ERROR,
      "warn": LogLevel.WARN,
      "info": LogLevel.INFO,
      "debug": LogLevel.DEBUG,
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
