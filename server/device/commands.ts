import { RejectReason } from '../protocol.ts';
import type { CommandName } from '../protocol.ts';
import { ADMIN_CONFIG } from '../constants/authConfig.ts';
import { verifyPassword } from '../auth/password.ts';
import type { ServerSocket } from '../constants/socketConfig.ts';
import type { ServerDeps } from '../deps.ts';
import { log } from '../utils/logger.ts';

/**
 * What running a command produced. A tagged result rather than "a reason, or
 * nothing": the same rule the protocol follows, so success and failure are
 * both something you have to look at.
 */
export type CommandOutcome = { ok: true } | { ok: false; reason: RejectReason };

export const DONE: CommandOutcome = { ok: true };
export function refuse(reason: RejectReason): CommandOutcome {
  return { ok: false, reason };
}

/**
 * A command's implementation. Arguments arrive untrusted, so each run narrows
 * them itself.
 *
 * Gating lives here rather than in the invoke handler because it differs per
 * command: authenticate has to work while the admin lock is held, or nobody
 * could ever release it.
 */
export interface CommandSpec {
  run(args: unknown, deps: ServerDeps, socket: ServerSocket): Promise<CommandOutcome>;
}

/** Untrusted args as a plain object; an empty one when the payload is not */
function argsObject(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
}

/**
 * The device's command table. Only what this server actually implements
 * appears here; the ready payload is built from these keys, so a client hides
 * controls for anything missing instead of guessing.
 */
export const COMMAND_IMPL: Partial<Record<CommandName, CommandSpec>> = {
  authenticate: {
    async run(args, deps, socket) {
      const password = argsObject(args).password;
      if (typeof password !== 'string') return refuse(RejectReason.INVALID_VALUE);

      if (!verifyPassword(password, ADMIN_CONFIG.ADMIN_PASSWORD_HASH)) {
        log.warn('command', socket, 'Socket failed admin authentication');
        return refuse(RejectReason.INVALID_PASSWORD);
      }

      deps.adminSessionManager.addAdminSocket(socket);
      // Note(yoochan.kim): isAdmin is per-connection, so it goes only to the client it describes.
      deps.notifier.stateTo(socket, { isAdmin: true });
      log.info('command', socket, 'Socket authenticated as admin');
      return DONE;
    },
  },

  enableConsoleInput: {
    async run(args, deps, socket) {
      const input = argsObject(args).input;
      // Note(yoochan.kim): which inputs exist is the desk's configuration, so
      // only it can say whether this is one
      if (!deps.mixerConsole.has(input)) return refuse(RejectReason.INVALID_VALUE);

      // Note(yoochan.kim): The console holds no protected state and its OSC bursts are
      // instantaneous, so this takes no audio lock — only the admin gate.
      const isAdmin = deps.adminSessionManager.isAdminSocket(socket);
      const allowed = await deps.lockCoordinator.withAdminGate(isAdmin, async () => {
        await deps.mixerConsole.enable(input);
      });

      if (!allowed) {
        log.warn('command', socket, 'Console input blocked (admin lock)', { input });
        return refuse(RejectReason.ADMIN_LOCKED);
      }
      return DONE;
    },
  },

  initializeConsole: {
    async run(_args, deps, socket) {
      // Note(yoochan.kim): gated exactly like enableConsoleInput — the desk keeps
      // no protected state, so the admin gate is the only thing in the way. The
      // pacing between steps belongs to the console, not here.
      const isAdmin = deps.adminSessionManager.isAdminSocket(socket);
      const allowed = await deps.lockCoordinator.withAdminGate(isAdmin, async () => {
        await deps.mixerConsole.initialize();
      });

      if (!allowed) {
        log.warn('command', socket, 'Console initialize blocked (admin lock)');
        return refuse(RejectReason.ADMIN_LOCKED);
      }
      return DONE;
    },
  },

  startFlow: {
    // Note(yoochan.kim): The whole plan arrives here; the server keeps none of it once the run
    // is over. Validation and scheduling belong to the runner.
    async run(args, deps) {
      return deps.flowRunner.start(args);
    },
  },

  stopFlow: {
    async run(_args, deps) {
      return deps.flowRunner.stop();
    },
  },
};

/** Command names this server implements, for the ready payload */
export const IMPLEMENTED_COMMANDS: readonly string[] = Object.keys(COMMAND_IMPL);
