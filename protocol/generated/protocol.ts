// Generated from protocol/protocol.json — do not edit by hand.
// Run `npm run gen-protocol` in church-media-server after changing the spec.

/**
 * The server is modelled as a device that describes itself: it exposes attributes
 * (state you read and write), commands (actions you invoke), and one event carrying
 * whatever changed. The architecture is borrowed from hardware buses like PCI —
 * enumerate the device, discover what it supports, access everything the same way —
 * but the vocabulary is the device-model one (attribute/command/event) rather than
 * literal registers, because these are named slots, not addressed words.
 */

export const PROTOCOL_VERSION = 1;

/** Whether the audio deck is sounding */
export const PlaybackState = {
  PAUSED: 'paused',
  PLAYING: 'playing',
} as const;
export type PlaybackState = (typeof PlaybackState)[keyof typeof PlaybackState];
export function isPlaybackState(value: unknown): value is PlaybackState {
  return typeof value === 'string' && (Object.values(PlaybackState) as string[]).includes(value);
}

/** Whether output is muted */
export const MuteState = {
  UNMUTED: 'unmuted',
  MUTED: 'muted',
} as const;
export type MuteState = (typeof MuteState)[keyof typeof MuteState];
export function isMuteState(value: unknown): value is MuteState {
  return typeof value === 'string' && (Object.values(MuteState) as string[]).includes(value);
}

/** Mixing console input. Inputs are independent, not alternatives. */
export const ConsoleInput = {
  MIC: 'mic',
  AUX: 'aux',
} as const;
export type ConsoleInput = (typeof ConsoleInput)[keyof typeof ConsoleInput];
export function isConsoleInput(value: unknown): value is ConsoleInput {
  return typeof value === 'string' && (Object.values(ConsoleInput) as string[]).includes(value);
}

/** How an attribute may be used */
export const Access = {
  READ_ONLY: 'ro',
  READ_WRITE: 'rw',
} as const;
export type Access = (typeof Access)[keyof typeof Access];
export function isAccess(value: unknown): value is Access {
  return typeof value === 'string' && (Object.values(Access) as string[]).includes(value);
}

/** Who may write an attribute or invoke a command */
export const Permission = {
  ANY: 'any',
  ADMIN: 'admin',
} as const;
export type Permission = (typeof Permission)[keyof typeof Permission];
export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (Object.values(Permission) as string[]).includes(value);
}

/**
 * Why a write or invoke was refused. Sent only to the client that issued it, so it can
 * explain itself instead of appearing to do nothing.
 */
export const RejectReason = {
  UNKNOWN_TARGET: 'unknownTarget',
  NOT_WRITABLE: 'notWritable',
  INVALID_VALUE: 'invalidValue',
  INVALID_PASSWORD: 'invalidPassword',
  NOT_ADMIN: 'notAdmin',
  ADMIN_LOCKED: 'adminLocked',
  DEVICE_BUSY: 'deviceBusy',
  UNKNOWN_TRACK: 'unknownTrack',
  FLOW_ACTIVE: 'flowActive',
  NO_FLOW: 'noFlow',
  WINDOW_PASSED: 'windowPassed',
  PROTOCOL_MISMATCH: 'protocolMismatch',
} as const;
export type RejectReason = (typeof RejectReason)[keyof typeof RejectReason];
export function isRejectReason(value: unknown): value is RejectReason {
  return typeof value === 'string' && (Object.values(RejectReason) as string[]).includes(value);
}

/**
 * A song a user can select and leave looping. The server names these, so renaming one
 * — or adding another — needs no client release.
 */
export interface Song {
  /** Value to write to the song attribute */
  id: string;
  /** Human-readable name to show */
  title: string;
}

/** A playable library entry. File paths never leave the server. */
export interface Track {
  /** Stable identifier used by startFlow */
  id: string;
  /** Human-readable name */
  title: string;
  /** Length in seconds, measured from the file */
  durationSec: number;
}

/** Which track of a flow is sounding right now */
export interface FlowTrack {
  title: string;
  /** 1-based position in the sequence */
  index: number;
  total: number;
}

/**
 * One part of a flow. A flow is a set of these, so a run can play music, hold the
 * admin lock, or both — and a new capability later is a new kind rather than a new
 * command.
 */
export type FlowPart =
  /**
   * Play these tracks in order so the last one finishes at endsAt. Started late, the
   * server joins the timeline part-way through.
   */
  | { kind: 'music'; tracks: string[]; endsAt: string }
  /**
   * Hold the global admin gate for this window. Releasing is its own step: music
   * ending does not release the lock.
   */
  | { kind: 'lock'; at: string; until: string }
  ;
export const FlowPartKind = {
  MUSIC: 'music',
  LOCK: 'lock',
} as const;

/**
 * What the server's one flow slot is doing. Each phase carries only the fields that
 * mean something in it, so a status cannot describe a state the server is not in. A
 * flow lives only for the length of its run — the schedule it came from stays with the
 * client that submitted it.
 */
export type FlowStatus =
  /** No flow is running */
  | { phase: 'idle' }
  /** A flow is accepted but none of its parts has started yet */
  | { phase: 'waiting'; name: string; startsAt: string }
  /** The flow's music is sounding */
  | { phase: 'playing'; name: string; track: FlowTrack; endsAt: string }
  /** Nothing is sounding, but the flow still holds the admin lock */
  | { phase: 'holding'; name: string; unlockAt: string }
  ;
export const FlowStatusKind = {
  IDLE: 'idle',
  WAITING: 'waiting',
  PLAYING: 'playing',
  HOLDING: 'holding',
} as const;

/** Every attribute this protocol defines, with how it may be used */
export const ATTRIBUTES = {
  /**
   * Whether the deck is playing. Writing it fades in or out and holds the audio lock
   * for the length of the fade.
   */
  playback: { access: 'rw', permission: 'any' },
  /**
   * Output volume. Applies immediately, so it is safe to write continuously while
   * dragging a fader.
   */
  volume: { access: 'rw', permission: 'any', range: { min: 0, max: 100 } },
  /** Whether output is muted */
  mute: { access: 'rw', permission: 'any' },
  /**
   * Id of the selected song, one of the ids listed in ready.songs. Writing it fades
   * out, switches, and restores that song's remembered position, paused. It is an id
   * rather than a fixed set because which songs exist, and what they are called, is
   * the server's to say.
   */
  song: { access: 'rw', permission: 'any' },
  /**
   * Global gate on non-admin writes. Any admin may release it, it survives
   * disconnects, and it is cleared by a restart.
   */
  adminLock: { access: 'rw', permission: 'admin' },
  /**
   * True while the audio device is mid-transition. Read-only, and it refuses everyone
   * including admins: it guards the device, not permissions.
   */
  audioLock: { access: 'ro' },
  /**
   * Whether this connection holds admin rights. Per-connection, so it is only ever
   * sent to the client it describes.
   */
  isAdmin: { access: 'ro' },
  /**
   * What the server's one flow slot is doing. Always readable: an idle slot says so
   * rather than reading as nothing. Read-only — startFlow and stopFlow change it.
   */
  flow: { access: 'ro' },
} as const;
export type AttributeName = keyof typeof ATTRIBUTES;

/** Every command this protocol defines */
export const COMMANDS = {
  /**
   * Claim admin rights for this connection. Success shows up as isAdmin in a state
   * patch; failure comes back as rejected with invalidPassword.
   */
  authenticate: { permission: 'any' },
  /**
   * Switch a mixing console input on. Not subject to the audio lock, and open to
   * anyone the admin lock is not holding back — the console keeps no protected state.
   * It reports nothing back, so there is no attribute to read.
   */
  enableConsoleInput: { permission: 'any' },
  /**
   * Hand the server one flow to run, and it owns that run to the end: it keeps to the
   * wall clock, restores the user's song afterwards, and cleans up however it
   * finishes. The schedule this came from stays with the caller — the server holds no
   * flow definitions and no calendar, it only executes what it is given. A flow is a
   * set of parts, at least one, and only one flow runs at a time. A flow whose every
   * part has already finished is refused with windowPassed rather than accepted and
   * completed instantly, so pressing start never looks like nothing happened.
   */
  startFlow: { permission: 'admin' },
  /**
   * End the running flow now: stop playback, restore the user's song, release the
   * admin lock.
   */
  stopFlow: { permission: 'admin' },
} as const;
export type CommandName = keyof typeof COMMANDS;

/** Attribute values. A state patch is any subset of these. */
export interface State {
  /**
   * Whether the deck is playing. Writing it fades in or out and holds the audio lock
   * for the length of the fade.
   */
  playback: PlaybackState;
  /**
   * Output volume. Applies immediately, so it is safe to write continuously while
   * dragging a fader.
   */
  volume: number;
  /** Whether output is muted */
  mute: MuteState;
  /**
   * Id of the selected song, one of the ids listed in ready.songs. Writing it fades
   * out, switches, and restores that song's remembered position, paused. It is an id
   * rather than a fixed set because which songs exist, and what they are called, is
   * the server's to say.
   */
  song: string;
  /**
   * Global gate on non-admin writes. Any admin may release it, it survives
   * disconnects, and it is cleared by a restart.
   */
  adminLock: boolean;
  /**
   * True while the audio device is mid-transition. Read-only, and it refuses everyone
   * including admins: it guards the device, not permissions.
   */
  audioLock: boolean;
  /**
   * Whether this connection holds admin rights. Per-connection, so it is only ever
   * sent to the client it describes.
   */
  isAdmin: boolean;
  /**
   * What the server's one flow slot is doing. Always readable: an idle slot says so
   * rather than reading as nothing. Read-only — startFlow and stopFlow change it.
   */
  flow: FlowStatus;
}
export type StatePatch = Partial<State>;

/** One write targets one attribute, so field and value stay in step. */
export type WriteRequest =
  | { field: 'playback'; value: PlaybackState }
  | { field: 'volume'; value: number }
  | { field: 'mute'; value: MuteState }
  | { field: 'song'; value: string }
  | { field: 'adminLock'; value: boolean }
  ;

/** One invoke runs one command, so command and args stay in step. */
export type InvokeRequest =
  | { command: 'authenticate'; args: { password: string } }
  | { command: 'enableConsoleInput'; args: { input: ConsoleInput } }
  | { command: 'startFlow'; args: { name: string; parts: FlowPart[] } }
  | { command: 'stopFlow'; args: Record<string, never> }
  ;

/** C2S event names */
export const C2S = {
  HELLO: 'hello',
  READ: 'read',
  WRITE: 'write',
  INVOKE: 'invoke',
} as const;
export type C2SEvent = (typeof C2S)[keyof typeof C2S];

/** Payload carried by each C2S event */
export interface C2SPayloads {
  /**
   * First message after connecting. Identifies the client and declares the protocol
   * version it speaks. The server answers with ready, then a full state.
   */
  hello: {
    /** Human-readable device name shown to the admin, e.g. '본당 태블릿' */
    client: string;
    protocolVersion: number;
  };
  /**
   * Ask for every attribute value, for example after waking from background. There is
   * no field selection: the whole state is small, and one shape is easier to keep
   * honest than two.
   */
  read: Record<string, never>;
  /**
   * Set one attribute. Refused when it is unknown, read-only, out of range, gated by
   * the admin lock, or the device is busy.
   */
  write: WriteRequest;
  /**
   * Run one command. Refused when it is unknown, the caller lacks permission, or its
   * arguments do not check out.
   */
  invoke: InvokeRequest;
}

/** S2C event names */
export const S2C = {
  READY: 'ready',
  STATE: 'state',
  REJECTED: 'rejected',
  PING: 'ping',
} as const;
export type S2CEvent = (typeof S2C)[keyof typeof S2C];

/** Payload carried by each S2C event */
export interface S2CPayloads {
  /**
   * Answer to hello: what this server speaks, what it supports, and the fixed track
   * library. When accepted is false the client is on an incompatible protocol version
   * — it should tell the user to update. State still arrives, but writes and invokes
   * are refused with protocolMismatch.
   */
  ready: {
    /** Version this server speaks */
    protocolVersion: number;
    accepted: boolean;
    /** Attributes this server implements. Hide controls for anything absent. */
    attributes: string[];
    /** Commands this server implements. Hide controls for anything absent. */
    commands: string[];
    /** Songs a user may select, with the names to show. Fixed at boot. */
    songs: Song[];
    /** Track library for flows, fixed at boot */
    tracks: Track[];
  };
  /**
   * Attributes that changed. Merge into the state held locally — absent fields are
   * unchanged. Sent in full after ready and in reply to read, and as a patch on every
   * change thereafter.
   */
  state: StatePatch;
  /**
   * A write or invoke was refused. Sent only to the client that issued it, so it can
   * say why instead of appearing to do nothing.
   */
  rejected: {
    /** Attribute or command name that was refused */
    target: string;
    reason: RejectReason;
  };
  /** Application-level heartbeat */
  ping: Record<string, never>;
}

/** Socket.IO map for clients: payloads are typed both ways */
export type ClientToServerEvents = { [K in keyof C2SPayloads]: (payload: C2SPayloads[K]) => void };
export type ServerToClientEvents = { [K in keyof S2CPayloads]: (payload: S2CPayloads[K]) => void };

/**
 * Server-side view of inbound events. Payloads arrive from untrusted clients,
 * so handlers receive `unknown` and must narrow before use.
 */
export type ClientToServerEventsUnsafe = { [K in keyof C2SPayloads]: (payload: unknown) => void };
