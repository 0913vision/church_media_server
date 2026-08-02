import { requireEnvOneOf } from './env.ts';

// Note(yoochan.kim): Severity order for level filtering
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;

type LogLevel = keyof typeof LOG_LEVELS;
const LOG_LEVEL_NAMES: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

// Note(yoochan.kim): Minimum level to print — LOG_LEVEL is a required, validated env variable
const MIN_LEVEL: number = LOG_LEVELS[requireEnvOneOf('LOG_LEVEL', LOG_LEVEL_NAMES)];

// Note(yoochan.kim): Anything with an id — a Socket.IO socket in practice
interface SocketLike {
  id: string;
}

type LogExtra = Record<string, unknown>;

/**
 * Local wall-clock time, to the second.
 *
 * Schedules are written and read in local time, so logs in UTC mean adding
 * nine hours in your head before a line means anything — and a flow that ran
 * exactly on time reads as if it ran nine hours early. The offset is kept in
 * the line so a log lifted onto another machine is still unambiguous.
 */
function timestamp(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const offset = `${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;

  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offset}`;
}

function write(level: LogLevel, message: string, context: LogExtra): void {
  if (LOG_LEVELS[level] < MIN_LEVEL) {
    return;
  }

  const contextStr = Object.keys(context).length > 0
    ? `[${Object.entries(context).map(([k, v]) => `${k}=${String(v)}`).join(',')}]`
    : '';

  console.log(`[${timestamp()}][${level.toUpperCase()}] ${message} ${contextStr}`);
}

function createContext(
  module: string,
  socket: SocketLike | null | undefined,
  extra: LogExtra = {}
): LogExtra {
  return {
    module,
    // Note(yoochan.kim): Only include socketId for socket-scoped logs (avoid "socketId=undefined")
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
