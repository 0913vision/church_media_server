import { ATTRIBUTES, C2S, COMMANDS, PROTOCOL_VERSION, RejectReason } from '../protocol.ts';
import type { AttributeName, CommandName, StatePatch } from '../protocol.ts';
import { ADMIN_CONTACT } from '../constants/contactConfig.ts';
import type { ServerSocket } from '../constants/socketConfig.ts';
import type { ServerDeps } from '../deps.ts';
import { ATTRIBUTE_IMPL, IMPLEMENTED_ATTRIBUTES, readState } from '../device/attributes.ts';
import { COMMAND_IMPL, IMPLEMENTED_COMMANDS } from '../device/commands.ts';
import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';

/** Narrows an untrusted payload to a plain object, or null */
function asObject(payload: unknown): Record<string, unknown> | null {
  return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : null;
}

/** Attributes carry a permission only when they are writable; default to open. */
function permissionOf(name: AttributeName): string {
  return (ATTRIBUTES[name] as { permission?: string }).permission ?? 'any';
}

/**
 * hello: identify the client and negotiate the protocol version, then answer
 * with what this server implements followed by the full state, so a client is
 * one round trip from a complete render.
 */
const registerHello = (socket: ServerSocket, deps: ServerDeps): void => {
  socket.on(C2S.HELLO, (payload: unknown) => {
    try {
      const parsed = asObject(payload);
      const client = typeof parsed?.client === 'string' ? parsed.client : 'unknown';
      const accepted = parsed?.protocolVersion === PROTOCOL_VERSION;

      socket.data.client = client;
      socket.data.accepted = accepted;

      if (!accepted) {
        log.warn('hello', socket, 'Client speaks a different protocol version', {
          client,
          clientVersion: parsed?.protocolVersion,
          serverVersion: PROTOCOL_VERSION,
        });
      } else {
        log.info('hello', socket, 'Client identified', { client });
      }

      deps.notifier.ready(socket, {
        protocolVersion: PROTOCOL_VERSION,
        accepted,
        attributes: [...IMPLEMENTED_ATTRIBUTES],
        commands: [...IMPLEMENTED_COMMANDS],
        // Note(yoochan.kim): The catalogues clients render from: the server names what a song is
        // called, so a rename never means a client release.
        songs: deps.trackLibrary.deckSongs(),
        tracks: deps.trackLibrary.list(),
        // Note(yoochan.kim): Printed on a client's error screens, so whoever is on duty can
        // change without anyone shipping a new app.
        contact: ADMIN_CONTACT,
      });
      deps.notifier.stateTo(socket, readState(deps, socket));
    } catch (error) {
      log.error('hello', socket, 'Error handling hello', { error: errorMessage(error) });
    }
  });
};

/**
 * read: answer with the requested attributes, or all of them. Unknown names
 * are ignored rather than refused — answering the understood part of a
 * question beats answering none of it.
 */
const registerRead = (socket: ServerSocket, deps: ServerDeps): void => {
  socket.on(C2S.READ, () => {
    try {
      deps.notifier.stateTo(socket, readState(deps, socket));
    } catch (error) {
      log.error('read', socket, 'Error reading attributes', { error: errorMessage(error) });
    }
  });
};

/**
 * write: set one attribute. Every refusal is reported back with a reason, so a
 * client can say why it did nothing instead of looking broken.
 */
const registerWrite = (socket: ServerSocket, deps: ServerDeps): void => {
  socket.on(C2S.WRITE, async (payload: unknown) => {
    const parsed = asObject(payload);
    const field = parsed?.field;
    const target = typeof field === 'string' ? field : C2S.WRITE;

    try {
      if (typeof field !== 'string') {
        deps.notifier.rejected(socket, target, RejectReason.INVALID_VALUE);
        return;
      }
      if (!socket.data.accepted) {
        deps.notifier.rejected(socket, target, RejectReason.PROTOCOL_MISMATCH);
        return;
      }

      const spec = ATTRIBUTE_IMPL[field as AttributeName] as (typeof ATTRIBUTE_IMPL)[AttributeName] | undefined;
      if (!spec) {
        deps.notifier.rejected(socket, target, RejectReason.UNKNOWN_TARGET);
        return;
      }
      if (!spec.write) {
        deps.notifier.rejected(socket, target, RejectReason.NOT_WRITABLE);
        return;
      }

      const isAdmin = deps.adminSessionManager.isAdminSocket(socket);
      if (permissionOf(field as AttributeName) === 'admin' && !isAdmin) {
        log.warn('write', socket, 'Non-admin attempted an admin write', { field });
        deps.notifier.rejected(socket, target, RejectReason.NOT_ADMIN);
        return;
      }

      // Note(yoochan.kim): The attribute decides why it said no: usually the value, but it may
      // also be something only it knows, like a flow owning the admin lock.
      const plan = spec.write.prepare(parsed?.value, deps);
      if (!plan.ok) {
        log.warn('write', socket, 'Write denied', { field, value: parsed?.value, reason: plan.reason });
        deps.notifier.rejected(socket, target, plan.reason);
        return;
      }

      // Note(yoochan.kim): The gate decides who may start work; the audio lock decides whether the
      // device is free. They are checked separately so the client learns which.
      if (!deps.lockCoordinator.passesAdminGate(isAdmin)) {
        deps.notifier.rejected(socket, target, RejectReason.ADMIN_LOCKED);
        return;
      }

      let patch: StatePatch = {};
      if (spec.write.holdsAudioLock) {
        const ran = await deps.lockCoordinator.withAudioLock(isAdmin, async () => {
          patch = await plan.apply();
        });
        if (!ran) {
          log.warn('write', socket, 'Write blocked, device busy', { field });
          deps.notifier.rejected(socket, target, RejectReason.DEVICE_BUSY);
          return;
        }
      } else {
        patch = await plan.apply();
      }

      // Note(yoochan.kim): An empty patch means the value was already what was asked for.
      if (Object.keys(patch).length > 0) {
        deps.notifier.state(patch);
      }
    } catch (error) {
      log.error('write', socket, 'Error writing attribute', { error: errorMessage(error), field });
    }
  });
};

/** invoke: run one command, reporting any refusal back to the caller. */
const registerInvoke = (socket: ServerSocket, deps: ServerDeps): void => {
  socket.on(C2S.INVOKE, async (payload: unknown) => {
    const parsed = asObject(payload);
    const command = parsed?.command;
    const target = typeof command === 'string' ? command : C2S.INVOKE;

    try {
      if (typeof command !== 'string') {
        deps.notifier.rejected(socket, target, RejectReason.INVALID_VALUE);
        return;
      }
      if (!socket.data.accepted) {
        deps.notifier.rejected(socket, target, RejectReason.PROTOCOL_MISMATCH);
        return;
      }

      const spec = COMMAND_IMPL[command as CommandName];
      if (!spec) {
        deps.notifier.rejected(socket, target, RejectReason.UNKNOWN_TARGET);
        return;
      }

      const meta = COMMANDS[command as CommandName] as { permission?: string } | undefined;
      const isAdmin = deps.adminSessionManager.isAdminSocket(socket);
      if (meta?.permission === 'admin' && !isAdmin) {
        log.warn('invoke', socket, 'Non-admin attempted an admin command', { command });
        deps.notifier.rejected(socket, target, RejectReason.NOT_ADMIN);
        return;
      }

      const outcome = await spec.run(parsed?.args, deps, socket);
      if (!outcome.ok) {
        deps.notifier.rejected(socket, target, outcome.reason);
      }
    } catch (error) {
      log.error('invoke', socket, 'Error invoking command', { error: errorMessage(error), command });
    }
  });
};

/** Registers every socket event handler for a connection. */
export const registerHandlers = (socket: ServerSocket, deps: ServerDeps): void => {
  registerHello(socket, deps);
  registerRead(socket, deps);
  registerWrite(socket, deps);
  registerInvoke(socket, deps);
};
