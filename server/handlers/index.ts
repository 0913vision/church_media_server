import { ATTRIBUTES, C2S, COMMANDS, PROTOCOL_VERSION, RejectReason } from '../protocol.ts';
import type { AttributeName, CommandName, StatePatch } from '../protocol.ts';
import { ADMIN_CONTACT } from '../constants/contactConfig.ts';
import type { ServerSocket } from '../constants/socketConfig.ts';
import type { ServerDeps } from '../deps.ts';
import { ATTRIBUTE_IMPL, IMPLEMENTED_ATTRIBUTES, readState } from '../device/attributes.ts';
import { COMMAND_IMPL, IMPLEMENTED_COMMANDS } from '../device/commands.ts';
import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';

function asObject(payload: unknown): Record<string, unknown> | null {
  return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : null;
}

/** Who sent something, by the name it gave at hello, so a line reads without looking the socket up. */
function who(socket: ServerSocket): { client: string } {
  return { client: socket.data.client ?? 'unknown' };
}

/** Masked because the admin web shows the log; commas become spaces since a log line separates fields with them. */
function brief(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const text = JSON.stringify(value, (key, inner: unknown) => (/password/i.test(key) ? '***' : inner)).replace(/,/g, ' ');
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** Attributes carry a permission only when they are writable; default to open. */
function permissionOf(name: AttributeName): string {
  return (ATTRIBUTES[name] as { permission?: string }).permission ?? 'any';
}

/** An older version belongs here only while a panel stuck on it remains, and only if the change is additive. */
const ACCEPTED_VERSIONS: readonly number[] = [PROTOCOL_VERSION];

/** Answers with ready then the full state, so a client is one round trip from a complete render. */
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
        // Note(yoochan.kim): warned every time, so the older entry in ACCEPTED_VERSIONS is not forgotten.
        log.warn('hello', socket, 'Client identified on an older protocol', {
          client,
          ip: socket.handshake.address,
          clientVersion: version,
          serverVersion: PROTOCOL_VERSION,
        });
      } else {
        // Note(yoochan.kim): the address rides along, so a name in the log can be matched to a device on the network.
        log.info('hello', socket, 'Client identified', { client, ip: socket.handshake.address });
      }

      deps.notifier.ready(socket, {
        protocolVersion: PROTOCOL_VERSION,
        accepted,
        attributes: [...IMPLEMENTED_ATTRIBUTES],
        commands: [...IMPLEMENTED_COMMANDS],
        // Note(yoochan.kim): the server names the songs, so a rename never means a client release.
        songs: deps.trackLibrary.deckSongs(),
        // Note(yoochan.kim): printed on clients' error screens, so the person on duty changes without an app release.
        contact: ADMIN_CONTACT,
      });
      deps.notifier.stateTo(socket, readState(deps, socket));
    } catch (error) {
      log.error('hello', socket, 'Error handling hello', { error: errorMessage(error) });
    }
  });
};

/** Unknown names are ignored rather than refused: answering the understood part beats answering none. */
const registerRead = (socket: ServerSocket, deps: ServerDeps): void => {
  socket.on(C2S.READ, () => {
    try {
      deps.notifier.stateTo(socket, readState(deps, socket));
    } catch (error) {
      log.error('read', socket, 'Error reading attributes', { error: errorMessage(error) });
    }
  });
};

/** Every refusal goes back with a reason, so a client can say why it did nothing instead of looking broken. */
const registerWrite = (socket: ServerSocket, deps: ServerDeps): void => {
  socket.on(C2S.WRITE, async (payload: unknown) => {
    const parsed = asObject(payload);
    const field = parsed?.field;
    const target = typeof field === 'string' ? field : C2S.WRITE;
    // Note(yoochan.kim): refusals are logged with who asked, so "I pressed it and nothing happened" can be answered.
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

      // Note(yoochan.kim): the attribute names its own reason, which may be a flow owning the admin lock.
      const plan = spec.write.prepare(parsed?.value, deps);
      if (!plan.ok) {
        refuse(plan.reason, 'Write denied', { value: brief(parsed?.value) });
        return;
      }

      // Note(yoochan.kim): the gate and the audio lock are checked apart, so the client learns which one said no.
      if (!deps.lockCoordinator.passesAdminGate(isAdmin)) {
        refuse(RejectReason.ADMIN_LOCKED);
        return;
      }

      // Note(yoochan.kim): logged before it acts, so the deck's lines read as its answer; a volume drag is one line.
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

export const registerHandlers = (socket: ServerSocket, deps: ServerDeps): void => {
  registerHello(socket, deps);
  registerRead(socket, deps);
  registerWrite(socket, deps);
  registerInvoke(socket, deps);
};
