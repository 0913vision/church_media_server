import { Server } from 'socket.io';
import { SOCKET_CONFIG } from './constants/socketConfig.ts';
import type { SocketData } from './constants/socketConfig.ts';
import type { ClientToServerEventsUnsafe, ServerToClientEvents } from './protocol.ts';
import { DEVICE_CONFIG } from './constants/deviceConfig.ts';
import { INITIAL_PLAYER_CONFIG } from './constants/playerConfig.ts';
import type { PlayerConfig } from './constants/playerConfig.ts';
import { PlaybackState } from './protocol.ts';
import Player from './player/Player.ts';
import MpvClient from './hardware/MpvClient.ts';
import AudioDevice from './hardware/AudioDevice.ts';
import LockCoordinator from './lock/LockCoordinator.ts';
import AdminSessionManager from './auth/AdminSessionManager.ts';
import MixerConsole from './console/MixerConsole.ts';
import X32Console from './console/X32Console.ts';
import MockConsole from './console/MockConsole.ts';
import TrackLibrary from './tracks/TrackLibrary.ts';
import FlowRunner from './flow/FlowRunner.ts';
import type { ConsoleDevice } from './console/ConsoleDevice.ts';
import Notifier from './notify/Notifier.ts';
import FileStateStore from './state/FileStateStore.ts';
import type { PersistedState } from './state/StateStore.ts';
import Clock from './clock/Clock.ts';
import { registerHandlers } from './handlers/index.ts';
import type { ServerDeps } from './deps.ts';
import { requireEnv } from './utils/env.ts';
import { log } from './utils/logger.ts';

/**
 * Composition root: builds the whole object graph explicitly (every
 * dependency is constructor-injected here), wires it into a dependency
 * context, and attaches handler registration to incoming connections.
 */
/** Socket.IO server parameterized with this project's protocol maps */
type TypedServer = Server<ClientToServerEventsUnsafe, ServerToClientEvents, Record<string, never>, SocketData>;

class MediaServer {
  private io: TypedServer | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private flowRunner: FlowRunner | null = null;

  start(): void {
    log.info('server', null, 'Socket is initializing');

    const io: TypedServer = new Server<
      ClientToServerEventsUnsafe,
      ServerToClientEvents,
      Record<string, never>,
      SocketData
    >(SOCKET_CONFIG.PORT, {
      cors: SOCKET_CONFIG.CORS,
    });
    this.io = io;

    // Shared singletons (created once, reused across all connections).
    // Only the Notifier touches io directly; everything else speaks domain.
    const notifier = new Notifier(io);

    // Restore persisted preferences (volume / mute / song) across restarts and
    // reboots, but always boot PAUSED — a reboot must never auto-start audio.
    const stateStore = new FileStateStore(requireEnv('STATE_FILE_PATH'));
    const restored = stateStore.load();
    const initialConfig: PlayerConfig = {
      ...INITIAL_PLAYER_CONFIG,
      ...(restored ?? {}),
      state: PlaybackState.PAUSED
    };

    // The clock correction outlives a reboot too: it describes the building,
    // not the run, and nobody should have to set it again after a power cut.
    const clock = new Clock(restored?.clockOffsetSec ?? 0);
    let preferences: PersistedState = {
      serverVolume: initialConfig.serverVolume,
      muted: initialConfig.muted,
      currentSong: initialConfig.currentSong,
    };
    const persist = (): void => stateStore.save({ ...preferences, clockOffsetSec: clock.offset() });
    clock.onChange(persist);

    const player = new Player(
      new AudioDevice(new MpvClient(), initialConfig.currentSong),
      initialConfig,
      (snapshot) => {
        preferences = snapshot;
        persist();
      }
    );

    const adminSessionManager = new AdminSessionManager();
    const lockCoordinator = new LockCoordinator(notifier);
    const consoleDevice: ConsoleDevice =
      DEVICE_CONFIG.CONSOLE_MODE === 'MOCK' ? new MockConsole() : new X32Console();
    const mixerConsole = new MixerConsole(consoleDevice);
    const trackLibrary = new TrackLibrary(requireEnv('TRACKS_MANIFEST_PATH'));
    const flowRunner = new FlowRunner(player, trackLibrary, lockCoordinator, notifier, clock);
    this.flowRunner = flowRunner;

    const deps: ServerDeps = {
      notifier,
      player,
      lockCoordinator,
      adminSessionManager,
      mixerConsole,
      trackLibrary,
      flowRunner,
      clock,
    };

    this.pingInterval = setInterval(() => {
      notifier.ping(clock.now());
    }, SOCKET_CONFIG.PING_INTERVAL_MS);

    io.on('connection', (socket) => {
      log.info('server', socket, 'Socket connected', { ip: socket.handshake.address });

      registerHandlers(socket, deps);

      socket.on('disconnect', (reason) => {
        // The admin lock is global state and intentionally persists past a
        // disconnect; only the admin session is dropped (by AdminSessionManager).
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

    // Cancel a run in flight so its timers cannot outlive the process.
    if (this.flowRunner) {
      this.flowRunner.dispose();
      this.flowRunner = null;
    }
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
