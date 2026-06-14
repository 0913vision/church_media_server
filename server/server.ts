import { Server } from 'socket.io';
import { SOCKET_CONFIG } from './constants/socketConfig.ts';
import type { ClientToServerEvents, ServerToClientEvents } from './constants/socketConfig.ts';
import { DEVICE_CONFIG } from './constants/deviceConfig.ts';
import { INITIAL_PLAYER_CONFIG } from './constants/playerConfig.ts';
import type { PlayerConfig } from './constants/playerConfig.ts';
import { PlayerState } from './constants/playerStates.ts';
import Player from './player/Player.ts';
import MpvClient from './hardware/MpvClient.ts';
import AudioDevice from './hardware/AudioDevice.ts';
import LockCoordinator from './lock/LockCoordinator.ts';
import AdminSessionManager from './auth/AdminSessionManager.ts';
import MixerConsole from './console/MixerConsole.ts';
import X32Console from './console/X32Console.ts';
import MockConsole from './console/MockConsole.ts';
import type { ConsoleDevice } from './console/ConsoleDevice.ts';
import Notifier from './notify/Notifier.ts';
import FileStateStore from './state/FileStateStore.ts';
import { registerHandlers } from './handlers/index.ts';
import type { HandlerDeps } from './handlers/index.ts';
import { requireEnv } from './utils/env.ts';
import { log } from './utils/logger.ts';

/**
 * Composition root: builds the whole object graph explicitly (every
 * dependency is constructor-injected here), wires it into a dependency
 * context, and attaches handler registration to incoming connections.
 */
/** Socket.IO server parameterized with this project's protocol maps */
type TypedServer = Server<ClientToServerEvents, ServerToClientEvents>;

class MediaServer {
  private io: TypedServer | null = null;
  private pingInterval: NodeJS.Timeout | null = null;

  start(): void {
    log.info('server', null, 'Socket is initializing');

    const io: TypedServer = new Server<ClientToServerEvents, ServerToClientEvents>(SOCKET_CONFIG.PORT, {
      cors: SOCKET_CONFIG.CORS,
    });
    this.io = io;

    // Shared singletons (created once, reused across all connections).
    // Only the Notifier touches io directly; everything else speaks domain.
    const notifier = new Notifier(io);

    // Restore persisted preferences (volume / mute / song) across restarts and
    // reboots, but always boot PAUSED — a reboot must never auto-start audio.
    const stateStore = new FileStateStore(requireEnv('STATE_FILE_PATH'));
    const initialConfig: PlayerConfig = {
      ...INITIAL_PLAYER_CONFIG,
      ...(stateStore.load() ?? {}),
      state: PlayerState.PAUSED
    };
    const player = new Player(
      new AudioDevice(new MpvClient(), initialConfig.currentSong),
      initialConfig,
      (snapshot) => stateStore.save(snapshot)
    );

    const adminSessionManager = new AdminSessionManager();
    const lockCoordinator = new LockCoordinator(notifier);
    const consoleDevice: ConsoleDevice =
      DEVICE_CONFIG.CONSOLE_MODE === 'MOCK' ? new MockConsole() : new X32Console();
    const mixerConsole = new MixerConsole(consoleDevice);

    const deps: HandlerDeps = { notifier, player, lockCoordinator, adminSessionManager, mixerConsole };

    this.pingInterval = setInterval(() => {
      notifier.ping();
    }, SOCKET_CONFIG.PING_INTERVAL_MS);

    io.on('connection', (socket) => {
      log.info('server', socket, 'Socket connected', { ip: socket.handshake.address });

      registerHandlers(socket, deps);

      socket.on('disconnect', (reason) => {
        lockCoordinator.handleDisconnect(socket.id);
        log.info('server', socket, 'Socket disconnected', { reason });
      });
    });
  }

  /**
   * Graceful shutdown: stop the heartbeat and close all socket connections.
   * The MPV instance is released when the process exits.
   */
  stop(): void {
    log.info('server', null, 'Shutting down');

    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.io) {
      this.io.close();
      this.io = null;
    }
  }
}

export default MediaServer;
