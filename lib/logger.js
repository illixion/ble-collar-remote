/**
 * Simple logging utility with consistent formatting and log levels.
 */

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class Logger {
  constructor(options = {}) {
    this.level = LOG_LEVELS[options.level] ?? LOG_LEVELS.info;
    this.prefix = options.prefix || '';
  }

  _formatTimestamp() {
    return new Date().toISOString();
  }

  _formatMessage(level, message, data) {
    const timestamp = this._formatTimestamp();
    const prefix = this.prefix ? `[${this.prefix}] ` : '';
    const dataStr = data !== undefined ? ` ${JSON.stringify(data)}` : '';
    return `${timestamp} ${level.toUpperCase().padEnd(5)} ${prefix}${message}${dataStr}`;
  }

  _log(level, message, data) {
    if (LOG_LEVELS[level] >= this.level) {
      const formatted = this._formatMessage(level, message, data);
      if (level === 'error') {
        console.error(formatted);
      } else if (level === 'warn') {
        console.warn(formatted);
      } else {
        console.log(formatted);
      }
    }
  }

  debug(message, data) {
    this._log('debug', message, data);
  }

  info(message, data) {
    this._log('info', message, data);
  }

  warn(message, data) {
    this._log('warn', message, data);
  }

  error(message, data) {
    this._log('error', message, data);
  }

  child(prefix) {
    return new Logger({
      level: Object.keys(LOG_LEVELS).find((k) => LOG_LEVELS[k] === this.level),
      prefix: this.prefix ? `${this.prefix}:${prefix}` : prefix,
    });
  }
}

module.exports = { Logger, LOG_LEVELS };
