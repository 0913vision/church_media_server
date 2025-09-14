class Logger {
  constructor() {
    this.logs = [];
    this.maxLogs = 1000;
  }

  log(level, message, context = {}) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context
    };

    // Console output with formatting
    const contextStr = Object.keys(context).length > 0 
      ? `[${Object.entries(context).map(([k, v]) => `${k}=${v}`).join(',')}]`
      : '';
    
    const logLine = `[${logEntry.timestamp}][${level.toUpperCase()}] ${message} ${contextStr}`;
    
    console.log(logLine);

    // Store in memory buffer
    this.logs.push(logEntry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    // TODO: Emit to admin clients via socket.io
  }

  info(message, context) {
    this.log('info', message, context);
  }

  warn(message, context) {
    this.log('warn', message, context);
  }

  error(message, context) {
    this.log('error', message, context);
  }

  debug(message, context) {
    this.log('debug', message, context);
  }
}

const globalLogger = new Logger();

function createContext(module, socket, extra = {}) {
  return {
    module,
    socketId: socket?.id,
    // TODO: Add admin check when AdminSessionManager is available
    // isAdmin: socket ? AdminSessionManager.isAdmin(socket.id) : false,
    ...extra
  };
}

export const log = {
  info: (module, socket, message, extra) => {
    globalLogger.info(message, createContext(module, socket, extra));
  },
  
  warn: (module, socket, message, extra) => {
    globalLogger.warn(message, createContext(module, socket, extra));
  },
  
  error: (module, socket, message, extra) => {
    globalLogger.error(message, createContext(module, socket, extra));
  },
  
  debug: (module, socket, message, extra) => {
    globalLogger.debug(message, createContext(module, socket, extra));
  }
};