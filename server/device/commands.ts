import { ConsoleInput, RejectReason, isConsoleInput } from '../protocol.ts';
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
      // isAdmin is per-connection, so it goes only to the client it describes.
      deps.notifier.stateTo(socket, { isAdmin: true });
      log.info('command', socket, 'Socket authenticated as admin');
      return DONE;
    },
  },

  enableConsoleInput: {
    async run(args, deps, socket) {
      const input = argsObject(args).input;
      if (!isConsoleInput(input)) return refuse(RejectReason.INVALID_VALUE);

      // The console holds no protected state and its OSC bursts are
      // instantaneous, so this takes no audio lock — only the admin gate.
      const isAdmin = deps.adminSessionManager.isAdminSocket(socket);
      const allowed = await deps.lockCoordinator.withAdminGate(isAdmin, async () => {
        if (input === ConsoleInput.MIC) {
          await deps.mixerConsole.enablePastorMic();
        } else {
          await deps.mixerConsole.enableAux();
        }
      });

      if (!allowed) {
        log.warn('command', socket, 'Console input blocked (admin lock)', { input });
        return refuse(RejectReason.ADMIN_LOCKED);
      }
      return DONE;
    },
  },
};

/** Command names this server implements, for the ready payload */
export const IMPLEMENTED_COMMANDS: readonly string[] = Object.keys(COMMAND_IMPL);
