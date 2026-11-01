import { createServer } from 'node:http';
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
import DeskHolds from './console/DeskHolds.ts';
import type { DeskJournalEntry } from './console/DeskHolds.ts';
import { CONSOLE_CONFIG } from './constants/consoleConfig.ts';
import LevelMatcher from './level/LevelMatcher.ts';
import { LEVEL_CONFIG } from './constants/levelConfig.ts';
import TrackLibrary from './tracks/TrackLibrary.ts';
import Uploads from './tracks/Uploads.ts';
import Fetcher from './tracks/Fetcher.ts';
import { createUploadDoor } from './tracks/uploadDoor.ts';
import { TRACK_CONFIG } from './constants/trackConfig.ts';
import FlowRunner from './flow/FlowRunner.ts';
import { FLOW_CONFIG } from './constants/flowConfig.ts';
import Schedule from './schedule/Schedule.ts';
import AutoStarter from './schedule/AutoStarter.ts';
import AdminSession from './lock/AdminSession.ts';
import type { ConsoleDevice } from './console/ConsoleDevice.ts';
import Notifier from './notify/Notifier.ts';
import FileStateStore from './state/FileStateStore.ts';
import type { PersistedState } from './state/StateStore.ts';
import Clock from './clock/Clock.ts';
import { createMockView } from './console/mockView.ts';
import { serveApk } from './update/apkProxy.ts';
import { registerHandlers } from './handlers/index.ts';
import type { ServerDeps } from './deps.ts';
import { requireEnv } from './utils/env.ts';
import { log } from './utils/logger.ts';

type TypedServer = Server<ClientToServerEventsUnsafe, ServerToClientEvents, Record<string, never>, SocketData>;

class MediaServer {
  private io: TypedServer | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private flowRunner: FlowRunner | null = null;
  private autoStarter: AutoStarter | null = null;
  private adminSession: AdminSession | null = null;
  private uploads: Uploads | null = null;
  private deskHolds: DeskHolds | null = null;
  private levelMatcher: LevelMatcher | null = null;

  start(): void {
    log.info('server', null, 'Socket is initializing');

    // Note(yoochan.kim): built first, because the HTTP door has to know whether a mock is behind it.
    const mockConsole = DEVICE_CONFIG.CONSOLE_MODE === 'MOCK' ? new MockConsole() : null;
    const consoleDevice: ConsoleDevice = mockConsole ?? new X32Console();
    // Note(yoochan.kim): a page that can move the masters must not exist when they are real.
    const serveMockDesk = mockConsole ? createMockView(mockConsole) : null;

    // Note(yoochan.kim): built before the HTTP server, because the upload door has to exist from the first request.
    const trackLibrary = new TrackLibrary(requireEnv('TRACKS_MANIFEST_PATH'), requireEnv('TRACKS_AUDIO_DIR'));
    const uploads = new Uploads(TRACK_CONFIG.UPLOAD_TTL_MS);
    this.uploads = uploads;
    const serveUploads = createUploadDoor(trackLibrary, uploads);
    const fetcher = new Fetcher(requireEnv('YTDLP_PATH'));

    // Note(yoochan.kim): HTTP only moves files; everything that changes the device speaks the socket protocol.
    const httpServer = createServer((req, res) => {
      if (serveMockDesk?.(req, res)) return;
      if (serveUploads(req, res)) return;
      void serveApk(req, res);
    });
    const io: TypedServer = new Server<
      ClientToServerEventsUnsafe,
      ServerToClientEvents,
      Record<string, never>,
      SocketData
    >(httpServer, {
      cors: SOCKET_CONFIG.CORS,
    });
    httpServer.listen(SOCKET_CONFIG.PORT);
    this.io = io;

    // Note(yoochan.kim): only the Notifier touches io directly; everything else speaks domain.
    const notifier = new Notifier(io);

    const schedule = new Schedule(requireEnv('SCHEDULE_FILE_PATH'));
    const stateStore = new FileStateStore(requireEnv('STATE_FILE_PATH'));
    const restored = stateStore.load();
    // Note(yoochan.kim): a song since dropped from the manifest cannot be loaded, so the deck takes the first.
    const restoredSong = trackLibrary.isDeckSong(restored?.currentSong) ? restored!.currentSong : undefined;
    const initialConfig: PlayerConfig = {
      ...INITIAL_PLAYER_CONFIG,
      ...(restored ?? {}),
      currentSong: restoredSong ?? trackLibrary.defaultSong(),
      // Note(yoochan.kim): always paused at boot, so a reboot never starts sound in the room.
      state: PlaybackState.PAUSED
    };

    // Note(yoochan.kim): the clock correction describes the building, not the run, so it outlives a power cut.
    const clock = new Clock(restored?.clockOffsetSec ?? 0);
    let preferences: PersistedState = {
      serverVolume: initialConfig.serverVolume,
      muted: initialConfig.muted,
      currentSong: initialConfig.currentSong,
    };
    let deskJournal: readonly DeskJournalEntry[] = restored?.deskJournal ?? [];
    const persist = (): void => stateStore.save({ ...preferences, clockOffsetSec: clock.offset(), deskJournal });
    clock.onChange(persist);

    const player = new Player(
      new AudioDevice(new MpvClient(), initialConfig.currentSong, trackLibrary.songFiles()),
      initialConfig,
      (song) => trackLibrary.volumeOf(song),
      (snapshot) => {
        preferences = snapshot;
        persist();
      }
    );
    // Note(yoochan.kim): positions are lost on restart; the fades are logged once so a later fade=in line has a length.
    log.info('player', null, 'Player restored', {
      song: initialConfig.currentSong,
      volume: initialConfig.serverVolume,
      mute: initialConfig.muted,
      at: 'every song at its beginning',
      fadeIn: `${DEVICE_CONFIG.FADE_IN_MS}ms from ${DEVICE_CONFIG.FADE_EDGE_DB} dB`,
      fadeOut: `${DEVICE_CONFIG.FADE_OUT_MS}ms to ${DEVICE_CONFIG.FADE_EDGE_DB} dB`,
    });

    const adminSessionManager = new AdminSessionManager();
    const lockCoordinator = new LockCoordinator(notifier);
    // Note(yoochan.kim): a hold's journal from before a stop is handed back here and restored once the desk answers.
    const deskHolds = new DeskHolds(consoleDevice, CONSOLE_CONFIG.HOLD, (entries) => {
      deskJournal = entries;
      persist();
    }, deskJournal);
    this.deskHolds = deskHolds;
    const mixerConsole = new MixerConsole(consoleDevice, deskHolds);
    mixerConsole.onChange(() => notifier.state({ console: mixerConsole.read() }));
    const flowRunner = new FlowRunner(
      player, trackLibrary, lockCoordinator, notifier, clock, mixerConsole,
      [...CONSOLE_CONFIG.BAND_ONLY.BLOCK, ...CONSOLE_CONFIG.BAND_ONLY.OPEN], FLOW_CONFIG.TIMING,
    );
    this.flowRunner = flowRunner;
    const levelMatcher = new LevelMatcher(
      player, trackLibrary, lockCoordinator, notifier, mixerConsole, flowRunner, LEVEL_CONFIG.TIMING,
    );
    this.levelMatcher = levelMatcher;
    const adminSession = new AdminSession(player, lockCoordinator, notifier, clock, levelMatcher);
    this.adminSession = adminSession;
    const autoStarter = new AutoStarter(schedule, clock, flowRunner);
    this.autoStarter = autoStarter;
    autoStarter.start();

    const deps: ServerDeps = {
      notifier,
      player,
      lockCoordinator,
      adminSessionManager,
      mixerConsole,
      trackLibrary,
      uploads,
      fetcher,
      flowRunner,
      schedule,
      autoStarter,
      adminSession,
      clock,
      levelMatcher,
    };

    this.pingInterval = setInterval(() => {
      notifier.ping(clock.now(), clock.offset());
    }, SOCKET_CONFIG.PING_INTERVAL_MS);

    io.on('connection', (socket) => {
      // Note(yoochan.kim): a client stuck on long-polling feels slow, and nothing else in the log shows the transport.
      log.info('server', socket, 'Socket connected', {
        ip: socket.handshake.address,
        transport: socket.conn.transport.name,
      });
      socket.conn.on('upgrade', (transport) => {
        log.info('server', socket, 'Transport upgraded', { transport: transport.name });
      });

      registerHandlers(socket, deps);

      socket.on('disconnect', (reason) => {
        // Note(yoochan.kim): the admin lock is global and outlives a disconnect; only the admin session is dropped.
        log.info('server', socket, 'Socket disconnected', { reason });
      });
    });
  }

  /** Leaves mpv to be released when the process exits. */
  stop(): void {
    log.info('server', null, 'Shutting down');

    // Note(yoochan.kim): Cancel a run in flight so its timers cannot outlive the process.
    if (this.flowRunner) {
      this.flowRunner.dispose();
      this.flowRunner = null;
    }
    if (this.autoStarter) {
      this.autoStarter.dispose();
      this.autoStarter = null;
    }
    if (this.adminSession) {
      this.adminSession.dispose();
      this.adminSession = null;
    }
    if (this.uploads) {
      this.uploads.dispose();
      this.uploads = null;
    }
    if (this.levelMatcher) {
      this.levelMatcher.dispose();
      this.levelMatcher = null;
    }
    if (this.deskHolds) {
      this.deskHolds.dispose();
      this.deskHolds = null;
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
