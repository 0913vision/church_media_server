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

/** Who sent something, by the name it gave at hello, so a line reads without looking the socket up. */
function who(socket: ServerSocket): { client: string } {
  return { client: socket.data.client ?? 'unknown' };
}

/**
 * A value as one log field. What a client sends is cut to a length, and anything
 * named like a password is masked, since the log is shown on the admin web. Its
 * commas become spaces: a log line already separates its fields with commas.
 */
function brief(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const text = JSON.stringify(value, (key, inner: unknown) => (/password/i.test(key) ? '***' : inner)).replace(/,/g, ' ');
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** Attributes carry a permission only when they are writable; default to open. */
function permissionOf(name: AttributeName): string {
  return (ATTRIBUTES[name] as { permission?: string }).permission ?? 'any';
}

/**
 * The protocol versions this server answers, newest first.
 *
 * PROTOCOL_VERSION is what it speaks and what it reports; this is who it is
 * willing to speak to. The two are usually the same list of one — an older
 * version belongs here only while a panel that cannot be updated yet is still
 * on it, and only while the difference is additive.
 */
const ACCEPTED_VERSIONS: readonly number[] = [PROTOCOL_VERSION];

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
      const version = parsed?.protocolVersion;
      const current = version === PROTOCOL_VERSION;
      const accepted = typeof version === 'number' && ACCEPTED_VERSIONS.includes(version);

      socket.data.client = client;
      socket.data.accepted = accepted;

      if (!accepted) {
        log.warn('hello', socket, 'Client speaks a different protocol version', {
          client,
          clientVersion: version,
          serverVersion: PROTOCOL_VERSION,
        });
      } else if (!current) {
        // Note(yoochan.kim): said out loud every time, so the older entry in
        // ACCEPTED_VERSIONS is not forgotten once the wall has been quiet.
        log.warn('hello', socket, 'Client identified on an older protocol', {
          client,
          ip: socket.handshake.address,
          clientVersion: version,
          serverVersion: PROTOCOL_VERSION,
        });
      } else {
        // Note(yoochan.kim): the address rides along, so a name in the log can
        // be matched to a device on the network without a second search
        log.info('hello', socket, 'Client identified', { client, ip: socket.handshake.address });
      }

      deps.notifier.ready(socket, {
        protocolVersion: PROTOCOL_VERSION,
        accepted,
        attributes: [...IMPLEMENTED_ATTRIBUTES],
        commands: [...IMPLEMENTED_COMMANDS],
        // Note(yoochan.kim): The catalogue clients render from: the server names what a song is
        // called, so a rename never means a client release.
        songs: deps.trackLibrary.deckSongs(),
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
    // Note(yoochan.kim): every refusal is written down with who asked, so "I pressed it and
    // nothing happened" can be answered from the log afterwards.
    const refuse = (reason: RejectReason, message = 'Write refused', extra: Record<string, unknown> = {}): void => {
      log.warn('write', socket, message, { ...who(socket), field: target, ...extra, reason });
      deps.notifier.rejected(socket, target, reason);
    };

    try {
      if (typeof field !== 'string') {
        refuse(RejectReason.INVALID_VALUE);
        return;
      }
      if (!socket.data.accepted) {
        refuse(RejectReason.PROTOCOL_MISMATCH);
        return;
      }

      const spec = ATTRIBUTE_IMPL[field as AttributeName] as (typeof ATTRIBUTE_IMPL)[AttributeName] | undefined;
      if (!spec) {
        refuse(RejectReason.UNKNOWN_TARGET);
        return;
      }
      if (!spec.write) {
        refuse(RejectReason.NOT_WRITABLE);
        return;
      }

      const isAdmin = deps.adminSessionManager.isAdminSocket(socket);
      if (permissionOf(field as AttributeName) === 'admin' && !isAdmin) {
        refuse(RejectReason.NOT_ADMIN, 'Non-admin attempted an admin write');
        return;
      }

      // Note(yoochan.kim): The attribute decides why it said no: usually the value, but it may
      // also be something only it knows, like a flow owning the admin lock.
      const plan = spec.write.prepare(parsed?.value, deps);
      if (!plan.ok) {
        refuse(plan.reason, 'Write denied', { value: brief(parsed?.value) });
        return;
      }

      // Note(yoochan.kim): The gate decides who may start work; the audio lock decides whether the
      // device is free. They are checked separately so the client learns which.
      if (!deps.lockCoordinator.passesAdminGate(isAdmin)) {
        refuse(RejectReason.ADMIN_LOCKED);
        return;
      }

      // Note(yoochan.kim): what was let through, by whom, before it acts — so the deck's own
      // lines that follow read as its answer. Volume is dragged by a hand: a drag is one line.
      if (field === 'volume') {
        log.drag(`${socket.id}:${field}`, 'write', socket, 'Write', parsed?.value, { ...who(socket), field });
      } else {
        log.info('write', socket, 'Write', { ...who(socket), field, value: brief(parsed?.value) });
      }

      let patch: StatePatch = {};
      if (spec.write.holdsAudioLock) {
        const ran = await deps.lockCoordinator.withAudioLock(isAdmin, async () => {
          patch = await plan.apply();
        });
        if (!ran) {
          refuse(RejectReason.DEVICE_BUSY, 'Write blocked, device busy');
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
    const refuse = (reason: RejectReason, message = 'Command refused'): void => {
      log.warn('invoke', socket, message, { ...who(socket), command: target, reason });
      deps.notifier.rejected(socket, target, reason);
    };

    try {
      if (typeof command !== 'string') {
        refuse(RejectReason.INVALID_VALUE);
        return;
      }
      if (!socket.data.accepted) {
        refuse(RejectReason.PROTOCOL_MISMATCH);
        return;
      }

      const spec = COMMAND_IMPL[command as CommandName];
      if (!spec) {
        refuse(RejectReason.UNKNOWN_TARGET);
        return;
      }

      const meta = COMMANDS[command as CommandName] as { permission?: string } | undefined;
      const isAdmin = deps.adminSessionManager.isAdminSocket(socket);
      if (meta?.permission === 'admin' && !isAdmin) {
        refuse(RejectReason.NOT_ADMIN, 'Non-admin attempted an admin command');
        return;
      }

      log.info('invoke', socket, 'Command', { ...who(socket), command, args: brief(parsed?.args) });
      const outcome = await spec.run(parsed?.args, deps, socket);
      if (!outcome.ok) {
        refuse(outcome.reason);
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
