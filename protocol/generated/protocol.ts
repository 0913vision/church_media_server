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
  ADMIN_UNLOCKED: 'adminUnlocked',
  DEVICE_BUSY: 'deviceBusy',
  UNKNOWN_TRACK: 'unknownTrack',
  UNKNOWN_FLOW: 'unknownFlow',
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

/** One track's level */
export interface TrackVolume {
  /** Track id from ready.tracks */
  id: string;
  /** 0-100 */
  volume: number;
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

/** The window a scheduled flow holds the gate for, as a weekly entry states it. */
export interface ScheduleLock {
  /** HH:MM or HH:MM:SS, church time */
  at: string;
  /** When it opens again */
  until: ScheduleUntil;
}

/**
 * One flow on the weekly calendar. A definition, not a run: editing it never touches a
 * run already in flight, because the runner was handed a copy when it started.
 */
export interface ScheduleEntry {
  /** Stable identifier, chosen by whoever wrote the entry */
  id: string;
  /** Display name, e.g. '수요 예배' */
  name: string;
  /** Which days it may run: mon, tue, wed, thu, fri, sat, sun. At least one. */
  weekdays: string[];
  /**
   * Whether it starts without anybody approving it. Dangerous on purpose: an
   * unattended service still needs its music.
   */
  autoStart: boolean;
  /** The gate window. Every flow has one. */
  lock: ScheduleLock;
  /**
   * What it does besides holding the gate. Empty for a lock-only flow; at most one of
   * each kind.
   */
  parts: SchedulePart[];
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
 * When a scheduled flow's gate opens again. Written as an intent rather than a copied
 * time, so moving the music moves the gate with it.
 */
export type ScheduleUntil =
  /** With the music. The usual case, and only valid on an entry that has a music part. */
  | { kind: 'music' }
  /**
   * At a time of its own — for an entry that holds the gate over something other than
   * music.
   */
  | { kind: 'clock'; at: string }
  ;
export const ScheduleUntilKind = {
  MUSIC: 'music',
  CLOCK: 'clock',
} as const;

/**
 * When the music an admin put on should stop. Three states rather than an instant that
 * may be absent, because 'nobody has said' and 'it runs until the gate lapses' are
 * different things, and only the first is worth warning about.
 */
export type MusicEnd =
  /**
   * Nobody has said. With loop on this is the one to warn about: repeating audio has
   * no end of its own, so the music runs until the gate lapses and takes it down —
   * which nobody asked for.
   */
  | { kind: 'undecided' }
  /**
   * Until the gate lapses, chosen deliberately. Same behaviour as undecided, and no
   * warning: somebody said so.
   */
  | { kind: 'withHold' }
  /**
   * Stops at this instant. The gate will not lapse before it — music that was given an
   * end gets to reach it.
   */
  | { kind: 'at'; at: string }
  ;
export const MusicEndKind = {
  UNDECIDED: 'undecided',
  WITH_HOLD: 'withHold',
  AT: 'at',
} as const;

/**
 * An instant something is due to happen at, or the fact that nothing is. A union
 * rather than a nullable instant, for the same reason as everywhere else here:
 * 'nothing is scheduled' is a state worth naming.
 */
export type Deadline =
  /** Nothing is due */
  | { kind: 'none' }
  /** Due at this instant */
  | { kind: 'at'; at: string }
  ;
export const DeadlineKind = {
  NONE: 'none',
  AT: 'at',
} as const;

/**
 * One thing a scheduled flow does, in the calendar's own vocabulary. The same kinds as
 * FlowPart, but the times are wall-clock rather than instants: a weekly entry says
 * 19:30, and which 19:30 is decided when it starts.
 */
export type SchedulePart =
  /** Play these tracks in order so the last one finishes at endsAt. */
  | { kind: 'music'; tracks: ScheduledTrack[]; endsAt: string }
  ;
export const SchedulePartKind = {
  MUSIC: 'music',
} as const;

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
 * What has the deck. The panel's own two-song deck is the ordinary case; a library
 * track is something an admin put on while the gate was held, and it comes off again
 * when the gate opens.
 */
export type DeckSource =
  /** The panel's deck. Which song is in the song attribute. */
  | { source: 'song' }
  /** A library track, which only an admin holding the gate can put on */
  | { source: 'track'; id: string }
  ;
export const DeckSourceKind = {
  SONG: 'song',
  TRACK: 'track',
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
   * for the length of the fade. Refused with flowActive while a flow's music is
   * sounding: the run was handed the deck and puts it back itself. A flow that only
   * holds the gate is keeping the panel out, not using the deck, so this stays
   * writable then.
   */
  playback: { access: 'rw', permission: 'any' },
  /**
   * Output volume, 0-100, whole numbers — a value with a fraction is rounded rather
   * than refused, since a dragged fader sends the ratio of a pixel to a width. Reports
   * what is *sounding*: while a run plays, this is the level that run was written
   * with, not the one the panel was left at, and the panel's own level comes back with
   * its song. Applies immediately, so it is safe to write continuously while dragging
   * a fader. Refused with flowActive while a flow's music is sounding: the run was
   * handed the deck and puts it back itself. A flow that only holds the gate is
   * keeping the panel out, not using the deck, so this stays writable then.
   */
  volume: { access: 'rw', permission: 'any', range: { min: 0, max: 100 } },
  /**
   * Whether output is muted. Refused with flowActive while a flow's music is sounding:
   * the run was handed the deck and puts it back itself. A flow that only holds the
   * gate is keeping the panel out, not using the deck, so this stays writable then.
   */
  mute: { access: 'rw', permission: 'any' },
  /**
   * Whether what is on the deck repeats. Always true unless the gate is held: the
   * panel's two songs are meant to run under a service without ending, and nobody at
   * the panel should be able to stop that. Writable only while the gate is held, and
   * refused with flowActive while a run's music is sounding — it describes what is on
   * the deck, and a run's track made to repeat is a timeline that never finishes. A
   * run merely holding the gate is not using the deck, so this stays writable then.
   * Reset to true when the gate opens — like everything else the gate changes, it goes
   * back to the user's state.
   */
  loop: { access: 'rw', permission: 'admin' },
  /**
   * The level each track sounds at, keyed by track id, 0-100. One setting serving
   * three uses: what a song returns to when it is chosen, what a library track is put
   * on at, and what a flow editor offers when this track joins a service. State rather
   * than part of ready.tracks, because somebody adjusts it while clients are
   * connected. Read-only — setTrackVolume moves it. A flow carries its own level for
   * every track it plays, so changing this never rewrites a service already written.
   */
  trackVolumes: { access: 'ro' },
  /**
   * What is on the deck: the panel's own song, or a library track an admin put on.
   * Read-only — song and playTrack are what move it.
   */
  deck: { access: 'ro' },
  /**
   * Whether the music stopping also releases the gate, restoring the user's song on
   * the way out. For putting one piece on and walking away. 'Stopping' means either
   * the track running out or musicEndsAt arriving — with loop on, only the latter can
   * ever happen. Writable only while a *person* is holding the gate — during a run the
   * gate is the run's and there is no hold to arm, so this is refused with flowActive.
   * False again once the gate opens.
   */
  unlockWhenDone: { access: 'rw', permission: 'admin' },
  /**
   * When the music an admin put on should stop. This is what makes a repeating track
   * finite: looping audio has no end of its own, so without it a gate held over that
   * music is held until somebody comes back. A client should ask the moment loop is
   * switched on, and while the answer is undecided say plainly — in words, not as an
   * alarm — that nothing will stop by itself. Reaching an instant stops the music and
   * puts the user's song back; the gate goes too if unlockWhenDone is on. Writable
   * only while a *person* is holding the gate, for the same reason unlockWhenDone is;
   * refused with flowActive during a run. Undecided again once the gate opens.
   */
  musicEndsAt: { access: 'rw', permission: 'admin' },
  /**
   * Id of the selected song, one of the ids listed in ready.songs. Writing it fades
   * out, switches, and restores that song's remembered position, paused. It is an id
   * rather than a fixed set because which songs exist, and what they are called, is
   * the server's to say. Refused with flowActive while a flow's music is sounding: the
   * run was handed the deck and puts it back itself. A flow that only holds the gate
   * is keeping the panel out, not using the deck, so this stays writable then.
   */
  song: { access: 'rw', permission: 'any' },
  /**
   * Global gate on non-admin writes. Any admin may release it, it survives
   * disconnects, and it is cleared by a restart. A gate a person engaged also lapses
   * by itself — see adminHold. A run engages the same gate, and a run starting over a
   * person's hold takes it: a scheduled service outranks an ad-hoc lock, and the hold
   * stops counting from that moment rather than expiring later under music that is
   * playing.
   */
  adminLock: { access: 'rw', permission: 'admin' },
  /**
   * When a gate a person engaged lapses by itself. It waits for music that has an end
   * — a track that will finish, or one told when to stop — because releasing under a
   * song that is still sounding opens the panel mid-music. Never more than an hour
   * ahead: a panel locked and forgotten is a panel nobody in the building can use, and
   * the person who locked it has usually gone home. Lapsing does what releasing does —
   * the user's song comes back with it. extendAdminHold pushes it out while somebody
   * is still there. Reads none when the gate is open, and while a flow holds it: a run
   * names its own window and ends on its own.
   */
  adminHold: { access: 'ro' },
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
   * The weekly calendar this server keeps: every flow that may be run, in the order
   * they were written. State rather than a one-shot list, because it is edited while
   * clients are connected. Read-only — saveFlow and deleteFlow move it. It lives here
   * because it is persistent, and because whether a track may be deleted depends on
   * whether a flow still names it, which only whoever holds both can answer.
   */
  schedule: { access: 'ro' },
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
   * Hand the server one run, spelled out in instants, and it owns that run to the end:
   * it keeps to the wall clock, restores the user's song afterwards, and cleans up
   * however it finishes. This is the primitive underneath startScheduledFlow, which is
   * how a calendar entry is normally run — reach for this one only to run something
   * that is not on the calendar. Every flow holds the admin gate for a window it
   * names, and music must finish inside that window: running past the unlock is
   * refused with musicOutsideLock rather than played on an open panel, as is music
   * that would end before the gate even engages, since it could never sound. A
   * timeline that begins before the window is accepted — the sound starts with the
   * lock and joins the timeline where it already is, the opening cut exactly like a
   * late start. Only one flow runs at a time. A flow whose window has already closed
   * is refused with windowPassed rather than accepted and completed instantly, so
   * pressing start never looks like nothing happened.
   */
  startFlow: { permission: 'admin' },
  /**
   * End the running flow now: stop playback, restore the user's song, release the
   * admin lock.
   */
  stopFlow: { permission: 'admin' },
  /**
   * Pushes back when the gate lapses, by thirty minutes, never past an hour from now.
   * So it can be pressed as often as somebody is there to press it, and the moment
   * nobody is, the hour starts running out. Refused with adminUnlocked when no gate is
   * held, and with flowActive while a flow holds one — a run's window is the run's.
   */
  extendAdminHold: { permission: 'admin' },
  /**
   * Create or replace one calendar entry, and write the calendar to disk. Validated
   * the way the file is at boot, so an entry saved here cannot be one the next boot
   * refuses. Refused with musicOutsideLock if the music could not finish inside the
   * gate window, and with unknownTrack if it names a track this server does not have —
   * both caught while somebody is still editing rather than at 19:30 on a Wednesday.
   */
  saveFlow: { permission: 'admin' },
  /**
   * Remove one calendar entry. A run already in flight is untouched — it stopped being
   * this entry the moment it started.
   */
  deleteFlow: { permission: 'admin' },
  /**
   * Run a calendar entry now. The server turns its wall-clock times into instants
   * against church time and the day it is being started on, then runs it exactly as
   * startFlow would. Refused with windowPassed if today is not one of its weekdays.
   */
  startScheduledFlow: { permission: 'admin' },
  /**
   * Pass over today's occurrence of an auto-start entry. Next week stands. Forgotten
   * at the end of the day and on restart — a skip is about one service, not a setting.
   */
  skipFlow: { permission: 'admin' },
  /**
   * Set the level a track sounds at, kept across restarts. Applies from the next time
   * the track is chosen — it does not move a level that is already playing, which is
   * what the volume attribute is for.
   */
  setTrackVolume: { permission: 'admin' },
  /**
   * Put a library track on the deck, paused at its start, at its own level — the same
   * act as writing the song attribute, for the tracks that are not among ready.songs.
   * Playing it is a separate write to playback. Refused with adminUnlocked unless the
   * gate is held: while the panel is open it shows the song it thinks is playing, and
   * a track it never chose would make that a lie. Refused with flowActive while a
   * run's music is sounding — a run holds the gate, so that first check passes during
   * a service and this one is what keeps the deck the run's. While a run only holds
   * the gate this is allowed, and what it puts on is faded out when the run's own
   * music comes due; the run goes back to the deck it was handed, not to the track
   * somebody put on during its quiet half. Releasing the gate takes the track off and
   * puts the user's song back.
   */
  selectTrack: { permission: 'admin' },
} as const;
export type CommandName = keyof typeof COMMANDS;

/** Attribute values. A state patch is any subset of these. */
export interface State {
  /**
   * Whether the deck is playing. Writing it fades in or out and holds the audio lock
   * for the length of the fade. Refused with flowActive while a flow's music is
   * sounding: the run was handed the deck and puts it back itself. A flow that only
   * holds the gate is keeping the panel out, not using the deck, so this stays
   * writable then.
   */
  playback: PlaybackState;
  /**
   * Output volume, 0-100, whole numbers — a value with a fraction is rounded rather
   * than refused, since a dragged fader sends the ratio of a pixel to a width. Reports
   * what is *sounding*: while a run plays, this is the level that run was written
   * with, not the one the panel was left at, and the panel's own level comes back with
   * its song. Applies immediately, so it is safe to write continuously while dragging
   * a fader. Refused with flowActive while a flow's music is sounding: the run was
   * handed the deck and puts it back itself. A flow that only holds the gate is
   * keeping the panel out, not using the deck, so this stays writable then.
   */
  volume: number;
  /**
   * Whether output is muted. Refused with flowActive while a flow's music is sounding:
   * the run was handed the deck and puts it back itself. A flow that only holds the
   * gate is keeping the panel out, not using the deck, so this stays writable then.
   */
  mute: MuteState;
  /**
   * Whether what is on the deck repeats. Always true unless the gate is held: the
   * panel's two songs are meant to run under a service without ending, and nobody at
   * the panel should be able to stop that. Writable only while the gate is held, and
   * refused with flowActive while a run's music is sounding — it describes what is on
   * the deck, and a run's track made to repeat is a timeline that never finishes. A
   * run merely holding the gate is not using the deck, so this stays writable then.
   * Reset to true when the gate opens — like everything else the gate changes, it goes
   * back to the user's state.
   */
  loop: boolean;
  /**
   * The level each track sounds at, keyed by track id, 0-100. One setting serving
   * three uses: what a song returns to when it is chosen, what a library track is put
   * on at, and what a flow editor offers when this track joins a service. State rather
   * than part of ready.tracks, because somebody adjusts it while clients are
   * connected. Read-only — setTrackVolume moves it. A flow carries its own level for
   * every track it plays, so changing this never rewrites a service already written.
   */
  trackVolumes: TrackVolume[];
  /**
   * What is on the deck: the panel's own song, or a library track an admin put on.
   * Read-only — song and playTrack are what move it.
   */
  deck: DeckSource;
  /**
   * Whether the music stopping also releases the gate, restoring the user's song on
   * the way out. For putting one piece on and walking away. 'Stopping' means either
   * the track running out or musicEndsAt arriving — with loop on, only the latter can
   * ever happen. Writable only while a *person* is holding the gate — during a run the
   * gate is the run's and there is no hold to arm, so this is refused with flowActive.
   * False again once the gate opens.
   */
  unlockWhenDone: boolean;
  /**
   * When the music an admin put on should stop. This is what makes a repeating track
   * finite: looping audio has no end of its own, so without it a gate held over that
   * music is held until somebody comes back. A client should ask the moment loop is
   * switched on, and while the answer is undecided say plainly — in words, not as an
   * alarm — that nothing will stop by itself. Reaching an instant stops the music and
   * puts the user's song back; the gate goes too if unlockWhenDone is on. Writable
   * only while a *person* is holding the gate, for the same reason unlockWhenDone is;
   * refused with flowActive during a run. Undecided again once the gate opens.
   */
  musicEndsAt: MusicEnd;
  /**
   * Id of the selected song, one of the ids listed in ready.songs. Writing it fades
   * out, switches, and restores that song's remembered position, paused. It is an id
   * rather than a fixed set because which songs exist, and what they are called, is
   * the server's to say. Refused with flowActive while a flow's music is sounding: the
   * run was handed the deck and puts it back itself. A flow that only holds the gate
   * is keeping the panel out, not using the deck, so this stays writable then.
   */
  song: string;
  /**
   * Global gate on non-admin writes. Any admin may release it, it survives
   * disconnects, and it is cleared by a restart. A gate a person engaged also lapses
   * by itself — see adminHold. A run engages the same gate, and a run starting over a
   * person's hold takes it: a scheduled service outranks an ad-hoc lock, and the hold
   * stops counting from that moment rather than expiring later under music that is
   * playing.
   */
  adminLock: boolean;
  /**
   * When a gate a person engaged lapses by itself. It waits for music that has an end
   * — a track that will finish, or one told when to stop — because releasing under a
   * song that is still sounding opens the panel mid-music. Never more than an hour
   * ahead: a panel locked and forgotten is a panel nobody in the building can use, and
   * the person who locked it has usually gone home. Lapsing does what releasing does —
   * the user's song comes back with it. extendAdminHold pushes it out while somebody
   * is still there. Reads none when the gate is open, and while a flow holds it: a run
   * names its own window and ends on its own.
   */
  adminHold: Deadline;
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
   * The weekly calendar this server keeps: every flow that may be run, in the order
   * they were written. State rather than a one-shot list, because it is edited while
   * clients are connected. Read-only — saveFlow and deleteFlow move it. It lives here
   * because it is persistent, and because whether a track may be deleted depends on
   * whether a flow still names it, which only whoever holds both can answer.
   */
  schedule: ScheduleEntry[];
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
  | { field: 'loop'; value: boolean }
  | { field: 'unlockWhenDone'; value: boolean }
  | { field: 'musicEndsAt'; value: MusicEnd }
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
  | { command: 'extendAdminHold'; args: Record<string, never> }
  | { command: 'saveFlow'; args: { flow: ScheduleEntry } }
  | { command: 'deleteFlow'; args: { id: string } }
  | { command: 'startScheduledFlow'; args: { id: string } }
  | { command: 'skipFlow'; args: { id: string } }
  | { command: 'setTrackVolume'; args: { id: string; volume: number } }
  | { command: 'selectTrack'; args: { id: string } }
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
