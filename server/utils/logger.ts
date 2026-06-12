import { requireEnvOneOf } from './env.ts';

// Severity order for level filtering
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;

type LogLevel = keyof typeof LOG_LEVELS;
const LOG_LEVEL_NAMES: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

// Minimum level to print — LOG_LEVEL is a required, validated env variable
const MIN_LEVEL: number = LOG_LEVELS[requireEnvOneOf('LOG_LEVEL', LOG_LEVEL_NAMES)];

// Anything with an id — a Socket.IO socket in practice
interface SocketLike {
  id: string;
}

type LogExtra = Record<string, unknown>;

function write(level: LogLevel, message: string, context: LogExtra): void {
  if (LOG_LEVELS[level] < MIN_LEVEL) {
    return;
  }

  const contextStr = Object.keys(context).length > 0
    ? `[${Object.entries(context).map(([k, v]) => `${k}=${String(v)}`).join(',')}]`
    : '';

  console.log(`[${new Date().toISOString()}][${level.toUpperCase()}] ${message} ${contextStr}`);
}

function createContext(
  module: string,
  socket: SocketLike | null | undefined,
  extra: LogExtra = {}
): LogExtra {
  return {
    module,
    // Only include socketId for socket-scoped logs (avoid "socketId=undefined")
    ...(socket ? { socketId: socket.id } : {}),
    ...extra
  };
}

export const log = {
  debug: (module: string, socket: SocketLike | null | undefined, message: string, extra?: LogExtra): void => {
    write('debug', message, createContext(module, socket, extra));
  },

  info: (module: string, socket: SocketLike | null | undefined, message: string, extra?: LogExtra): void => {
    write('info', message, createContext(module, socket, extra));
  },

  warn: (module: string, socket: SocketLike | null | undefined, message: string, extra?: LogExtra): void => {
    write('warn', message, createContext(module, socket, extra));
  },

  error: (module: string, socket: SocketLike | null | undefined, message: string, extra?: LogExtra): void => {
    write('error', message, createContext(module, socket, extra));
  }
};
