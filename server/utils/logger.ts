// Severity order for level filtering
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

// Minimum level to print, from LOG_LEVEL env (default: info, so debug is
// suppressed unless explicitly enabled)
const MIN_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.info;

function write(level, message, context) {
  if (LOG_LEVELS[level] < MIN_LEVEL) {
    return;
  }

  const contextStr = Object.keys(context).length > 0
    ? `[${Object.entries(context).map(([k, v]) => `${k}=${v}`).join(',')}]`
    : '';

  console.log(`[${new Date().toISOString()}][${level.toUpperCase()}] ${message} ${contextStr}`);
}

function createContext(module, socket, extra = {}) {
  return {
    module,
    // Only include socketId for socket-scoped logs (avoid "socketId=undefined")
    ...(socket ? { socketId: socket.id } : {}),
    ...extra
  };
}

export const log = {
  debug: (module, socket, message, extra) => {
    write('debug', message, createContext(module, socket, extra));
  },

  info: (module, socket, message, extra) => {
    write('info', message, createContext(module, socket, extra));
  },

  warn: (module, socket, message, extra) => {
    write('warn', message, createContext(module, socket, extra));
  },

  error: (module, socket, message, extra) => {
    write('error', message, createContext(module, socket, extra));
  }
};
