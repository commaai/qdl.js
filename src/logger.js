/** @enum {number} */
export const LogLevel = { SILENT: 0, ERROR: 1, WARN: 2, INFO: 3, DEBUG: 4 };

/**
 * Configurable logger with different log levels and device message deduplication.
 * Features: log levels, auto-deduplication, debouncing for repeated messages.
 */
export class Logger {
  /**
   * @param {string} name
   * @param {number} [level=LogLevel.INFO]
   */
  constructor(name, level = LogLevel.INFO) {
    this.name = name;
    this.level = level;
    this.prefix = name ? `[${name}] ` : "";
    this.deviceState = {
      lastMessage: "", lastLogLevel: LogLevel.INFO, count: 0,
      timeout: null, debounceMs: 100,
    };
  }

  #log(method, logLevel, args) {
    if (this.level < logLevel) return;
    this.prefix ? method(this.prefix, ...args) : method(...args);
  }

  debug(...args) { this.#log(console.debug, LogLevel.DEBUG, args); }
  info(...args) { this.#log(console.info, LogLevel.INFO, args); }
  warn(...args) { this.#log(console.warn, LogLevel.WARN, args); }
  error(...args) { this.#log(console.error, LogLevel.ERROR, args); }

  /**
   * Process and potentially display a device message
   * @param {string} message - Raw message from device
   */
  deviceMessage(message) {
    if (this.level < LogLevel.INFO) return;

    let formattedMessage, logLevel = LogLevel.INFO;
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
      state.timeout = setTimeout(() => this.#printPendingDeviceDuplicates(), state.debounceMs);
    }
  }

  /**
   * Print message showing duplicate count if any are pending
   * @private
   */
  #printPendingDeviceDuplicates() {
    const state = this.deviceState;
    if (state.count <= 1) return;
    const logMethod = state.lastLogLevel === LogLevel.ERROR ? console.error : console.info;
    logMethod(`[Device] Last message repeated ${state.count - 1} times`);
    state.count = 1;
  }

  /**
   * Flush any pending duplicate message counts and clear timeouts
   */
  flushDeviceMessages() {
    const { timeout } = this.deviceState;
    if (timeout) {
      clearTimeout(timeout);
      this.deviceState.timeout = null;
    }
    this.#printPendingDeviceDuplicates();
  }
}

/**
 * @returns {number}
 */
function getGlobalLogLevel() {
  const envLevel = typeof process !== "undefined" && process.env?.QDL_LOG_LEVEL;
  if (!envLevel) return LogLevel.INFO;

  const level = Number.parseInt(envLevel, 10);
  if (!Number.isNaN(level) && level >= 0 && level <= 4) return level;

  const namedLevels = {
    "silent": LogLevel.SILENT, "error": LogLevel.ERROR, "warn": LogLevel.WARN,
    "info": LogLevel.INFO, "debug": LogLevel.DEBUG,
  };
  return namedLevels[envLevel.toLowerCase()] || LogLevel.INFO;
}

export const globalLogLevel = getGlobalLogLevel();

/**
 * @param {string} [name]
 * @param {number} [level]
 * @returns {Logger}
 */
export function createLogger(name = "", level = globalLogLevel) {
  return new Logger(name, level);
}
