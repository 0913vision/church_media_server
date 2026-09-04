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

export const PROTOCOL_VERSION = 3;

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
  MUSIC_OUTSIDE_LOCK: 'musicOutsideLock',
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

/**
 * Who to call when this server is not working. Configured on the server, for the same
 * reason song titles are: the person responsible changes far more often than the
 * clients do, and nobody should need a release to print a new number.
 */
export interface Contact {
  /** Person responsible for this server */
  name: string;
  /** Number to call, already formatted for display */
  phone: string;
}

/**
 * The window a flow holds the admin gate for. Every flow has one: a run that plays
 * music while the panel is still open lets the tablet take the deck out from under it,
 * so the gate is not something a caller can decline.
 */
export interface FlowLock {
  /** Instant to engage the lock. Already past means immediately. */
  at: string;
  /** Instant to release it. Must be after at, and must cover every part. */
  until: string;
}

/** A playable library entry. File paths never leave the server. */
export interface Track {
  /** Stable identifier used by startFlow */
  id: string;
  /** Human-readable name */
  title: string;
  /** Length in seconds, measured from the file */
  durationSec: number;
  /**
   * The level this track sounds at when nobody says otherwise, 0-100. Sent so an
   * editor can offer it as the starting value when someone adds this track to a flow;
   * the flow itself then carries a level for every track it plays.
   */
  volume: number;
}

/**
 * One track in a flow's music sequence, with the level it plays at. The level is
 * always given: an editor starts it at the track's own volume and the person can lower
 * or raise it there, so what a flow will sound like is decided when it is written
 * rather than inherited from whatever the panel was left at.
 */
export interface ScheduledTrack {
  /** Track id from ready.tracks */
  id: string;
  /** Level for this track in this flow, 0-100 */
  volume: number;
}

/** Which track of a flow is sounding right now */
export interface FlowTrack {
  title: string;
  /** 1-based position in the sequence */
  index: number;
  total: number;
}

/**
 * One input this server drives, as the desk last answered for it. A client draws one
 * control per entry using the label it is given — how many inputs there are and what
 * they are called belongs to the building, not to any app, so rewiring or renaming one
 * is a server change alone. An input may cover several console channels: switching it
 * on drives all of them, while the reading follows the first.
 */
export interface ConsoleInput {
  /** Value to pass to enableConsoleInput */
  id: string;
  /** What to call it on screen, e.g. '목사님 마이크' */
  label: string;
  /**
   * Where this input is meant to sit, in decibels — the level enableConsoleInput puts
   * it back to. Marked on a meter, it shows at a glance that a fader has been moved by
   * hand.
   */
  nominalDb: number;
  state: ConsoleRead;
}

/**
 * One thing a flow does on top of holding the gate. The lock is not among these: every
 * flow holds it, so it is a field of the flow rather than a part that could be left
 * out. A new capability later is a new kind here rather than a new command.
 */
export type FlowPart =
  /**
   * Play these tracks in order so the last one finishes at endsAt. Started late, the
   * server joins the timeline part-way through. The whole span must fall inside the
   * flow's lock window.
   */
  | { kind: 'music'; tracks: ScheduledTrack[]; endsAt: string }
  ;
export const FlowPartKind = {
  MUSIC: 'music',
} as const;

/**
 * One console input as last heard from the desk. The console answers over UDP with no
 * session, so silence is a real state: unknown says nobody has heard, not that the
 * input is off.
 */
export type ConsoleRead =
  /** No answer from the console yet, or the last one has gone stale */
  | { kind: 'unknown' }
  /** The desk's own answer */
  | { kind: 'read'; on: boolean; db: number }
  ;
export const ConsoleReadKind = {
  UNKNOWN: 'unknown',
  READ: 'read',
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
  | { phase: 'waiting'; id: string; name: string; startsAt: string }
  /** The flow's music is sounding */
  | { phase: 'playing'; id: string; name: string; track: FlowTrack; endsAt: string }
  /** Nothing is sounding, but the flow still holds the admin lock */
  | { phase: 'holding'; id: string; name: string; unlockAt: string }
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
  /**
   * How far ahead of standard time the church clock runs, in seconds. Negative means
   * behind. Every instant on this wire is read against it, so writing it moves the
   * whole schedule. Refused with adminLocked while the gate is held: a flow holds the
   * gate for its whole run, which makes it impossible to move the clock out from under
   * music that is already playing. Survives restarts.
   */
  clockOffsetSec: { access: 'rw', permission: 'admin', range: { min: -3600, max: 3600 } },
  /**
   * The inputs this server drives, in the order to show them, each with what the
   * mixing desk itself reports for it. Read-only: enableConsoleInput changes the desk,
   * and the desk's next answer changes this. Each starts unknown and falls back to
   * unknown when the desk stops answering, so a dead console never wears a live face.
   */
  console: { access: 'ro' },
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
   * Put the mixing desk into the state a service starts from: every input on, the mute
   * group released, and the masters at their levels. The steps are ordered and paced
   * by the server, because raising the main before the matrix has come down would let
   * the room hear everything at once. Like enableConsoleInput it takes no audio lock
   * and reports nothing back — the desk's own answers arrive through the console
   * attribute. Takes a few hundred milliseconds to finish, so a client should not
   * expect the reading to have changed by the time the call returns.
   */
  initializeConsole: { permission: 'any' },
  /**
   * Hand the server one flow to run, and it owns that run to the end: it keeps to the
   * wall clock, restores the user's song afterwards, and cleans up however it
   * finishes. The schedule this came from stays with the caller — the server holds no
   * flow definitions and no calendar, it only executes what it is given. Every flow
   * holds the admin gate for a window it names, and music must finish inside that
   * window: running past the unlock is refused with musicOutsideLock rather than
   * played on an open panel, as is music that would end before the gate even engages,
   * since it could never sound. A timeline that begins before the window is accepted —
   * the sound starts with the lock and joins the timeline where it already is, the
   * opening cut exactly like a late start. Only one flow runs at a time. A flow whose
   * window has already closed is refused with windowPassed rather than accepted and
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
  /**
   * How far ahead of standard time the church clock runs, in seconds. Negative means
   * behind. Every instant on this wire is read against it, so writing it moves the
   * whole schedule. Refused with adminLocked while the gate is held: a flow holds the
   * gate for its whole run, which makes it impossible to move the clock out from under
   * music that is already playing. Survives restarts.
   */
  clockOffsetSec: number;
  /**
   * The inputs this server drives, in the order to show them, each with what the
   * mixing desk itself reports for it. Read-only: enableConsoleInput changes the desk,
   * and the desk's next answer changes this. Each starts unknown and falls back to
   * unknown when the desk stops answering, so a dead console never wears a live face.
   */
  console: ConsoleInput[];
}
export type StatePatch = Partial<State>;

/** One write targets one attribute, so field and value stay in step. */
export type WriteRequest =
  | { field: 'playback'; value: PlaybackState }
  | { field: 'volume'; value: number }
  | { field: 'mute'; value: MuteState }
  | { field: 'song'; value: string }
  | { field: 'adminLock'; value: boolean }
  | { field: 'clockOffsetSec'; value: number }
  ;

/** One invoke runs one command, so command and args stay in step. */
export type InvokeRequest =
  | { command: 'authenticate'; args: { password: string } }
  | { command: 'enableConsoleInput'; args: { input: string } }
  | { command: 'initializeConsole'; args: Record<string, never> }
  | { command: 'startFlow'; args: { id: string; name: string; lock: FlowLock; parts: FlowPart[] } }
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
    /**
     * Songs a user may select, with the names to show, in the order to show them. How
     * many there are is the server's to say, so a client draws one control per entry
     * rather than assuming a count — adding a song is then a server change alone.
     * Fixed at boot.
     */
    songs: Song[];
    /** Track library for flows, fixed at boot */
    tracks: Track[];
    /**
     * Who a client should tell the user to call when something is broken. Fixed at
     * boot.
     */
    contact: Contact;
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
  /**
   * Application-level heartbeat, carrying the server's own church time. A client draws
   * 'now' from this rather than from its own clock — the point of the offset is that
   * local clocks disagree, and a countdown drawn against a wrong one would be wrong in
   * exactly the situation this exists for.
   */
  ping: {
    /** Church time at the moment this was sent */
    at: string;
    /**
     * The correction in force at that same moment, so standard time is recoverable
     * exactly. A client holds the offset as an attribute too, but that one can have
     * moved since this beat was sent — taking a stale one back out of `at` is how a
     * clock ends up wrong by the size of the last correction.
     */
    offsetSec: number;
  };
}

/** Socket.IO map for clients: payloads are typed both ways */
export type ClientToServerEvents = { [K in keyof C2SPayloads]: (payload: C2SPayloads[K]) => void };
export type ServerToClientEvents = { [K in keyof S2CPayloads]: (payload: S2CPayloads[K]) => void };

/**
 * Server-side view of inbound events. Payloads arrive from untrusted clients,
 * so handlers receive `unknown` and must narrow before use.
 */
export type ClientToServerEventsUnsafe = { [K in keyof C2SPayloads]: (payload: unknown) => void };
