import { requireEnvOneOf } from './env.ts';

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;

type LogLevel = keyof typeof LOG_LEVELS;
const LOG_LEVEL_NAMES: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

const MIN_LEVEL: number = LOG_LEVELS[requireEnvOneOf('LOG_LEVEL', LOG_LEVEL_NAMES)];

interface SocketLike {
  id: string;
}

type LogExtra = Record<string, unknown>;

/** Local time like the schedules, offset kept for a log read elsewhere; ms as a press and its effect share a second. */
function timestamp(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const offsetMinutes = -at.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const offset = `${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;

  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}` +
    `.${String(at.getMilliseconds()).padStart(3, '0')}${offset}`;
}

function print(level: LogLevel, message: string, context: LogExtra, at: Date): void {
  if (LOG_LEVELS[level] < MIN_LEVEL) {
    return;
  }

  const contextStr = Object.keys(context).length > 0
    ? `[${Object.entries(context).map(([k, v]) => `${k}=${String(v)}`).join(',')}]`
    : '';

  console.log(`[${timestamp(at)}][${level.toUpperCase()}] ${message} ${contextStr}`);
}

const DRAG_QUIET_MS = 700;

interface Drag {
  message: string;
  context: LogExtra;
  first: unknown;
  last: unknown;
  steps: number;
  startedAt: Date;
  lastAt: Date;
  timer: ReturnType<typeof setTimeout>;
}

const drags = new Map<string, Drag>();

function flushDrag(key: string): void {
  const drag = drags.get(key);
  if (!drag) return;
  clearTimeout(drag.timer);
  drags.delete(key);
  const run = drag.steps > 1
    ? { from: drag.first, steps: drag.steps, over: `${((drag.lastAt.getTime() - drag.startedAt.getTime()) / 1000).toFixed(1)}s` }
    : {};
  print('info', drag.message, { ...drag.context, value: drag.last, ...run }, drag.lastAt);
}

// Note(yoochan.kim): open runs are written before any other line so the log keeps the order things happened in.
function flushDrags(): void {
  for (const key of [...drags.keys()]) flushDrag(key);
}

function quietTimer(key: string): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => flushDrag(key), DRAG_QUIET_MS);
  timer.unref?.();
  return timer;
}

function write(level: LogLevel, message: string, context: LogExtra): void {
  flushDrags();
  print(level, message, context, new Date());
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
  },

  /** Folds a dragged value's steps under one key into one info line, so a drag cannot push the rest off the log. */
  drag: (
    key: string, module: string, socket: SocketLike | null | undefined, message: string, value: unknown, extra?: LogExtra,
  ): void => {
    const now = new Date();
    const open = drags.get(key);
    if (open) {
      clearTimeout(open.timer);
      open.last = value;
      open.steps += 1;
      open.lastAt = now;
      open.timer = quietTimer(key);
      return;
    }
    flushDrags();
    drags.set(key, {
      message,
      context: createContext(module, socket, extra),
      first: value,
      last: value,
      steps: 1,
      startedAt: now,
      lastAt: now,
      timer: quietTimer(key),
    });
  },
};
