import { ConsoleInput, RejectReason, isConsoleInput } from '../protocol.ts';
import type { CommandName } from '../protocol.ts';
import { ADMIN_CONFIG } from '../constants/authConfig.ts';
import { verifyPassword } from '../auth/password.ts';
import type { ServerSocket } from '../constants/socketConfig.ts';
import type { ServerDeps } from '../deps.ts';
import { log } from '../utils/logger.ts';

/**
 * A command's implementation. Arguments arrive untrusted, so each run narrows
 * them itself and answers with a reject reason, or null when it succeeded.
 *
 * Gating lives here rather than in the invoke handler because it differs per
 * command: authenticate has to work while the admin lock is held, or nobody
 * could ever release it.
 */
export interface CommandSpec {
  run(args: unknown, deps: ServerDeps, socket: ServerSocket): Promise<RejectReason | null>;
}

function argsObject(args: unknown): Record<string, unknown> | null {
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : null;
}

/**
 * The device's command table. Only what this server actually implements
 * appears here; the ready payload is built from these keys, so a client hides
 * controls for anything missing instead of guessing.
 */
export const COMMAND_IMPL: Partial<Record<CommandName, CommandSpec>> = {
  authenticate: {
    async run(args, deps, socket) {
      const parsed = argsObject(args);
      const password = parsed?.password;
      if (typeof password !== 'string') return RejectReason.INVALID_VALUE;

      if (!verifyPassword(password, ADMIN_CONFIG.ADMIN_PASSWORD_HASH)) {
        log.warn('command', socket, 'Socket failed admin authentication');
        return RejectReason.INVALID_PASSWORD;
      }

      deps.adminSessionManager.addAdminSocket(socket);
      // isAdmin is per-connection, so it goes only to the client it describes.
      deps.notifier.stateTo(socket, { isAdmin: true });
      log.info('command', socket, 'Socket authenticated as admin');
      return null;
    },
  },

  enableConsoleInput: {
    async run(args, deps, socket) {
      const parsed = argsObject(args);
      const input = parsed?.input;
      if (!isConsoleInput(input)) return RejectReason.INVALID_VALUE;

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
        return RejectReason.ADMIN_LOCKED;
      }
      return null;
    },
  },
};

/** Command names this server implements, for the ready payload */
export const IMPLEMENTED_COMMANDS: readonly string[] = Object.keys(COMMAND_IMPL);
