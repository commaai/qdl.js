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
      console.debug(`[${this.name}]`, ...args);
    }
  }

  /**
   * @param {...any} args
   */
  info(...args) {
    if (this.level >= LogLevel.INFO) {
      console.info(`[${this.name}]`, ...args);
    }
  }

  /**
   * @param {...any} args
   */
  warn(...args) {
    if (this.level >= LogLevel.WARN) {
      console.warn(`[${this.name}]`, ...args);
    }
  }

  /**
   * @param {...any} args
   */
  error(...args) {
    if (this.level >= LogLevel.ERROR) {
      console.error(`[${this.name}]`, ...args);
    }
  }

  /**
   * @param {string} message
   */
  deviceMessage(message) {
    if (this.level < LogLevel.INFO) return;
    
    if (message.startsWith("ERROR:")) {
      if (this.level >= LogLevel.ERROR) {
        console.error(`[Device] ${message.substring(6).trim()}`);
      }
    } else if (message.startsWith("INFO:")) {
      if (this.level >= LogLevel.INFO) {
        console.info(`[Device] ${message.substring(5).trim()}`);
      }
    } else {
      if (this.level >= LogLevel.INFO) {
        console.info(`[Device] ${message}`);
      }
    }
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