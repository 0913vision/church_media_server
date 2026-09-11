# Generated from protocol/protocol.json — do not edit by hand.
# Run `npm run gen-protocol` in church-media-server after changing the spec.

from __future__ import annotations

from enum import Enum
from typing import Literal, TypedDict

"""
The server is modelled as a device that describes itself: it exposes
attributes (state you read and write), commands (actions you invoke), and one
event carrying whatever changed. The architecture is borrowed from hardware
buses like PCI — enumerate the device, discover what it supports, access
everything the same way — but the vocabulary is the device-model one
(attribute/command/event) rather than literal registers, because these are
named slots, not addressed words.
"""

PROTOCOL_VERSION = 3


class PlaybackState(str, Enum):
    """Whether the audio deck is sounding"""
    PAUSED = "paused"
    PLAYING = "playing"


class MuteState(str, Enum):
    """Whether output is muted"""
    UNMUTED = "unmuted"
    MUTED = "muted"


class Access(str, Enum):
    """How an attribute may be used"""
    READ_ONLY = "ro"
    READ_WRITE = "rw"


class Permission(str, Enum):
    """Who may write an attribute or invoke a command"""
    ANY = "any"
    ADMIN = "admin"


class RejectReason(str, Enum):
    """
    Why a write or invoke was refused. Sent only to the client that issued it,
    so it can explain itself instead of appearing to do nothing.
    """
    UNKNOWN_TARGET = "unknownTarget"
    NOT_WRITABLE = "notWritable"
    INVALID_VALUE = "invalidValue"
    INVALID_PASSWORD = "invalidPassword"
    NOT_ADMIN = "notAdmin"
    ADMIN_LOCKED = "adminLocked"
    ADMIN_UNLOCKED = "adminUnlocked"
    DEVICE_BUSY = "deviceBusy"
    UNKNOWN_TRACK = "unknownTrack"
    UNKNOWN_FLOW = "unknownFlow"
    FLOW_ACTIVE = "flowActive"
    NO_FLOW = "noFlow"
    WINDOW_PASSED = "windowPassed"
    MUSIC_OUTSIDE_LOCK = "musicOutsideLock"
    PROTOCOL_MISMATCH = "protocolMismatch"


class Song(TypedDict):
    """
    A song a user can select and leave looping. The server names these, so
    renaming one — or adding another — needs no client release.
    """
    id: str  # Value to write to the song attribute
    title: str  # Human-readable name to show


class Contact(TypedDict):
    """
    Who to call when this server is not working. Configured on the server, for
    the same reason song titles are: the person responsible changes far more
    often than the clients do, and nobody should need a release to print a new
    number.
    """
    name: str  # Person responsible for this server
    phone: str  # Number to call, already formatted for display


class FlowLock(TypedDict):
    """
    The window a flow holds the admin gate for. Every flow has one: a run that
    plays music while the panel is still open lets the tablet take the deck
    out from under it, so the gate is not something a caller can decline.
    """
    at: str  # Instant to engage the lock. Already past means immediately.
    until: str  # Instant to release it. Must be after at, and must cover every part.


class TrackVolume(TypedDict):
    """One track's level"""
    id: str  # Track id from ready.tracks
    volume: float  # 0-100


class Track(TypedDict):
    """A playable library entry. File paths never leave the server."""
    id: str  # Stable identifier used by startFlow
    title: str  # Human-readable name
    durationSec: float  # Length in seconds, measured from the file


class ScheduledTrack(TypedDict):
    """
    One track in a flow's music sequence, with the level it plays at. The
    level is always given: an editor starts it at the track's own volume and
    the person can lower or raise it there, so what a flow will sound like is
    decided when it is written rather than inherited from whatever the panel
    was left at.
    """
    id: str  # Track id from ready.tracks
    volume: float  # Level for this track in this flow, 0-100


class ScheduleLock(TypedDict):
    """
    The window a scheduled flow holds the gate for, as a weekly entry states
    it.
    """
    at: str  # HH:MM or HH:MM:SS, church time
    until: ScheduleUntil  # When it opens again


class ScheduleEntry(TypedDict):
    """
    One flow on the weekly calendar. A definition, not a run: editing it never
    touches a run already in flight, because the runner was handed a copy when
    it started.
    """
    id: str  # Stable identifier, chosen by whoever wrote the entry
    name: str  # Display name, e.g. '수요 예배'
    weekdays: list[str]  # Which days it may run: mon, tue, wed, thu, fri, sat, sun. At least one.
    autoStart: bool  # Whether it starts without anybody approving it. Dangerous on purpose: an unattended service still needs its music.
    lock: ScheduleLock  # The gate window. Every flow has one.
    parts: list[SchedulePart]  # What it does besides holding the gate. Empty for a lock-only flow; at most one of each kind.


class FlowTrack(TypedDict):
    """Which track of a flow is sounding right now"""
    title: str
    index: float  # 1-based position in the sequence
    total: float


class ConsoleInput(TypedDict):
    """
    One input this server drives, as the desk last answered for it. A client
    draws one control per entry using the label it is given — how many inputs
    there are and what they are called belongs to the building, not to any
    app, so rewiring or renaming one is a server change alone. An input may
    cover several console channels: switching it on drives all of them, while
    the reading follows the first.
    """
    id: str  # Value to pass to enableConsoleInput
    label: str  # What to call it on screen, e.g. '목사님 마이크'
    nominalDb: float  # Where this input is meant to sit, in decibels — the level enableConsoleInput puts it back to. Marked on a meter, it shows at a glance that a fader has been moved by hand.
    state: ConsoleRead


class ScheduleUntilMusic(TypedDict):
    """
    With the music. The usual case, and only valid on an entry that has a
    music part.
    """
    kind: Literal["music"]


class ScheduleUntilClock(TypedDict):
    """
    At a time of its own — for an entry that holds the gate over something
    other than music.
    """
    kind: Literal["clock"]
    at: str  # HH:MM or HH:MM:SS, church time


"""
When a scheduled flow's gate opens again. Written as an intent rather than a
copied time, so moving the music moves the gate with it.
"""
ScheduleUntil = ScheduleUntilMusic | ScheduleUntilClock


class MusicEndUndecided(TypedDict):
    """
    Nobody has said. With loop on this is the one to warn about: repeating
    audio has no end of its own, so the music runs until the gate lapses and
    takes it down — which nobody asked for.
    """
    kind: Literal["undecided"]


class MusicEndWithHold(TypedDict):
    """
    Until the gate lapses, chosen deliberately. Same behaviour as undecided,
    and no warning: somebody said so.
    """
    kind: Literal["withHold"]


class MusicEndAt(TypedDict):
    """
    Stops at this instant. The gate will not lapse before it — music that was
    given an end gets to reach it.
    """
    kind: Literal["at"]
    at: str  # Church-time instant, no more than an hour ahead


"""
When the music an admin put on should stop. Three states rather than an
instant that may be absent, because 'nobody has said' and 'it runs until the
gate lapses' are different things, and only the first is worth warning about.
"""
MusicEnd = MusicEndUndecided | MusicEndWithHold | MusicEndAt


class DeadlineNone(TypedDict):
    """Nothing is due"""
    kind: Literal["none"]


class DeadlineAt(TypedDict):
    """Due at this instant"""
    kind: Literal["at"]
    at: str  # Church-time instant


"""
An instant something is due to happen at, or the fact that nothing is. A union
rather than a nullable instant, for the same reason as everywhere else here:
'nothing is scheduled' is a state worth naming.
"""
Deadline = DeadlineNone | DeadlineAt


class SchedulePartMusic(TypedDict):
    """Play these tracks in order so the last one finishes at endsAt."""
    kind: Literal["music"]
    tracks: list[ScheduledTrack]  # The tracks in play order, each with the level it plays at
    endsAt: str  # HH:MM or HH:MM:SS, church time. Seconds are allowed because track lengths are not whole minutes.


"""
One thing a scheduled flow does, in the calendar's own vocabulary. The same
kinds as FlowPart, but the times are wall-clock rather than instants: a weekly
entry says 19:30, and which 19:30 is decided when it starts.
"""
SchedulePart = SchedulePartMusic


class FlowPartMusic(TypedDict):
    """
    Play these tracks in order so the last one finishes at endsAt. Started
    late, the server joins the timeline part-way through. The whole span must
    fall inside the flow's lock window.
    """
    kind: Literal["music"]
    tracks: list[ScheduledTrack]  # The tracks in play order, each with the level it plays at
    endsAt: str  # Instant the last track must finish


"""
One thing a flow does on top of holding the gate. The lock is not among these:
every flow holds it, so it is a field of the flow rather than a part that
could be left out. A new capability later is a new kind here rather than a new
command.
"""
FlowPart = FlowPartMusic


class DeckSourceSong(TypedDict):
    """The panel's deck. Which song is in the song attribute."""
    source: Literal["song"]


class DeckSourceTrack(TypedDict):
    """A library track, which only an admin holding the gate can put on"""
    source: Literal["track"]
    id: str  # Track id from ready.tracks


"""
What has the deck. The panel's own two-song deck is the ordinary case; a
library track is something an admin put on while the gate was held, and it
comes off again when the gate opens.
"""
DeckSource = DeckSourceSong | DeckSourceTrack


class ConsoleReadUnknown(TypedDict):
    """No answer from the console yet, or the last one has gone stale"""
    kind: Literal["unknown"]


class ConsoleReadRead(TypedDict):
    """The desk's own answer"""
    kind: Literal["read"]
    on: bool
    db: float  # The input's level in decibels, which is what the desk itself shows. The console speaks a 0..1 fader position instead; the curve between the two — four straight segments, steeper at the bottom — is applied here so it lives in one place rather than in every client that wants to show a level.


"""
One console input as last heard from the desk. The console answers over UDP
with no session, so silence is a real state: unknown says nobody has heard,
not that the input is off.
"""
ConsoleRead = ConsoleReadUnknown | ConsoleReadRead


class FlowStatusIdle(TypedDict):
    """No flow is running"""
    phase: Literal["idle"]


class FlowStatusWaiting(TypedDict):
    """A flow is accepted but none of its parts has started yet"""
    phase: Literal["waiting"]
    id: str  # The id the caller gave this flow, handed back so it can tell which of its flows is running. A name cannot: two may share one.
    name: str
    startsAt: str  # Instant its first part begins


class FlowStatusPlaying(TypedDict):
    """The flow's music is sounding"""
    phase: Literal["playing"]
    id: str  # The id the caller gave this flow, handed back so it can tell which of its flows is running. A name cannot: two may share one.
    name: str
    track: FlowTrack
    endsAt: str  # Instant the music finishes


class FlowStatusHolding(TypedDict):
    """Nothing is sounding, but the flow still holds the admin lock"""
    phase: Literal["holding"]
    id: str  # The id the caller gave this flow, handed back so it can tell which of its flows is running. A name cannot: two may share one.
    name: str
    unlockAt: str  # Instant the lock releases


"""
What the server's one flow slot is doing. Each phase carries only the fields
that mean something in it, so a status cannot describe a state the server is
not in. A flow lives only for the length of its run — the schedule it came
from stays with the client that submitted it.
"""
FlowStatus = FlowStatusIdle | FlowStatusWaiting | FlowStatusPlaying | FlowStatusHolding


class State(TypedDict):
    """Attribute values, all present."""
    playback: PlaybackState  # Whether the deck is playing. Writing it fades in or out and holds the audio lock for the length of the fade. Refused with flowActive while a flow's music is sounding: the run was handed the deck and puts it back itself. A flow that only holds the gate is keeping the panel out, not using the deck, so this stays writable then.
    volume: float  # Output volume. Applies immediately, so it is safe to write continuously while dragging a fader. Refused with flowActive while a flow's music is sounding: the run was handed the deck and puts it back itself. A flow that only holds the gate is keeping the panel out, not using the deck, so this stays writable then.
    mute: MuteState  # Whether output is muted. Refused with flowActive while a flow's music is sounding: the run was handed the deck and puts it back itself. A flow that only holds the gate is keeping the panel out, not using the deck, so this stays writable then.
    loop: bool  # Whether what is on the deck repeats. Always true unless the gate is held: the panel's two songs are meant to run under a service without ending, and nobody at the panel should be able to stop that. Writable only while the gate is held, and reset to true when it opens — like everything else the gate changes, it goes back to the user's state.
    trackVolumes: list[TrackVolume]  # The level each track sounds at, keyed by track id, 0-100. One setting serving three uses: what a song returns to when it is chosen, what a library track is put on at, and what a flow editor offers when this track joins a service. State rather than part of ready.tracks, because somebody adjusts it while clients are connected. Read-only — setTrackVolume moves it. A flow carries its own level for every track it plays, so changing this never rewrites a service already written.
    deck: DeckSource  # What is on the deck: the panel's own song, or a library track an admin put on. Read-only — song and playTrack are what move it.
    unlockWhenDone: bool  # Whether the music stopping also releases the gate, restoring the user's song on the way out. For putting one piece on and walking away. 'Stopping' means either the track running out or musicEndsAt arriving — with loop on, only the latter can ever happen. Writable only while the gate is held, and false again once it opens.
    musicEndsAt: MusicEnd  # When the music an admin put on should stop. This is what makes a repeating track finite: looping audio has no end of its own, so without it a gate held over that music is held until somebody comes back. A client should ask the moment loop is switched on, and while the answer is undecided say plainly — in words, not as an alarm — that nothing will stop by itself. Reaching an instant stops the music and puts the user's song back; the gate goes too if unlockWhenDone is on. Writable only while the gate is held, and undecided again once it opens.
    song: str  # Id of the selected song, one of the ids listed in ready.songs. Writing it fades out, switches, and restores that song's remembered position, paused. It is an id rather than a fixed set because which songs exist, and what they are called, is the server's to say. Refused with flowActive while a flow's music is sounding: the run was handed the deck and puts it back itself. A flow that only holds the gate is keeping the panel out, not using the deck, so this stays writable then.
    adminLock: bool  # Global gate on non-admin writes. Any admin may release it, it survives disconnects, and it is cleared by a restart. A gate a person engaged also lapses by itself — see adminHold.
    adminHold: Deadline  # When a gate a person engaged lapses by itself. It waits for music that has an end — a track that will finish, or one told when to stop — because releasing under a song that is still sounding opens the panel mid-music. Never more than an hour ahead: a panel locked and forgotten is a panel nobody in the building can use, and the person who locked it has usually gone home. Lapsing does what releasing does — the user's song comes back with it. extendAdminHold pushes it out while somebody is still there. Reads none when the gate is open, and while a flow holds it: a run names its own window and ends on its own.
    audioLock: bool  # True while the audio device is mid-transition. Read-only, and it refuses everyone including admins: it guards the device, not permissions.
    isAdmin: bool  # Whether this connection holds admin rights. Per-connection, so it is only ever sent to the client it describes.
    flow: FlowStatus  # What the server's one flow slot is doing. Always readable: an idle slot says so rather than reading as nothing. Read-only — startFlow and stopFlow change it.
    schedule: list[ScheduleEntry]  # The weekly calendar this server keeps: every flow that may be run, in the order they were written. State rather than a one-shot list, because it is edited while clients are connected. Read-only — saveFlow and deleteFlow move it. It lives here because it is persistent, and because whether a track may be deleted depends on whether a flow still names it, which only whoever holds both can answer.
    clockOffsetSec: float  # How far ahead of standard time the church clock runs, in seconds. Negative means behind. Every instant on this wire is read against it, so writing it moves the whole schedule. Refused with adminLocked while the gate is held: a flow holds the gate for its whole run, which makes it impossible to move the clock out from under music that is already playing. Survives restarts.
    console: list[ConsoleInput]  # The inputs this server drives, in the order to show them, each with what the mixing desk itself reports for it. Read-only: enableConsoleInput changes the desk, and the desk's next answer changes this. Each starts unknown and falls back to unknown when the desk stops answering, so a dead console never wears a live face.


class StatePatch(TypedDict, total=False):
    """Attributes that changed. Absent means unchanged."""
    playback: PlaybackState  # Whether the deck is playing. Writing it fades in or out and holds the audio lock for the length of the fade. Refused with flowActive while a flow's music is sounding: the run was handed the deck and puts it back itself. A flow that only holds the gate is keeping the panel out, not using the deck, so this stays writable then.
    volume: float  # Output volume. Applies immediately, so it is safe to write continuously while dragging a fader. Refused with flowActive while a flow's music is sounding: the run was handed the deck and puts it back itself. A flow that only holds the gate is keeping the panel out, not using the deck, so this stays writable then.
    mute: MuteState  # Whether output is muted. Refused with flowActive while a flow's music is sounding: the run was handed the deck and puts it back itself. A flow that only holds the gate is keeping the panel out, not using the deck, so this stays writable then.
    loop: bool  # Whether what is on the deck repeats. Always true unless the gate is held: the panel's two songs are meant to run under a service without ending, and nobody at the panel should be able to stop that. Writable only while the gate is held, and reset to true when it opens — like everything else the gate changes, it goes back to the user's state.
    trackVolumes: list[TrackVolume]  # The level each track sounds at, keyed by track id, 0-100. One setting serving three uses: what a song returns to when it is chosen, what a library track is put on at, and what a flow editor offers when this track joins a service. State rather than part of ready.tracks, because somebody adjusts it while clients are connected. Read-only — setTrackVolume moves it. A flow carries its own level for every track it plays, so changing this never rewrites a service already written.
    deck: DeckSource  # What is on the deck: the panel's own song, or a library track an admin put on. Read-only — song and playTrack are what move it.
    unlockWhenDone: bool  # Whether the music stopping also releases the gate, restoring the user's song on the way out. For putting one piece on and walking away. 'Stopping' means either the track running out or musicEndsAt arriving — with loop on, only the latter can ever happen. Writable only while the gate is held, and false again once it opens.
    musicEndsAt: MusicEnd  # When the music an admin put on should stop. This is what makes a repeating track finite: looping audio has no end of its own, so without it a gate held over that music is held until somebody comes back. A client should ask the moment loop is switched on, and while the answer is undecided say plainly — in words, not as an alarm — that nothing will stop by itself. Reaching an instant stops the music and puts the user's song back; the gate goes too if unlockWhenDone is on. Writable only while the gate is held, and undecided again once it opens.
    song: str  # Id of the selected song, one of the ids listed in ready.songs. Writing it fades out, switches, and restores that song's remembered position, paused. It is an id rather than a fixed set because which songs exist, and what they are called, is the server's to say. Refused with flowActive while a flow's music is sounding: the run was handed the deck and puts it back itself. A flow that only holds the gate is keeping the panel out, not using the deck, so this stays writable then.
    adminLock: bool  # Global gate on non-admin writes. Any admin may release it, it survives disconnects, and it is cleared by a restart. A gate a person engaged also lapses by itself — see adminHold.
    adminHold: Deadline  # When a gate a person engaged lapses by itself. It waits for music that has an end — a track that will finish, or one told when to stop — because releasing under a song that is still sounding opens the panel mid-music. Never more than an hour ahead: a panel locked and forgotten is a panel nobody in the building can use, and the person who locked it has usually gone home. Lapsing does what releasing does — the user's song comes back with it. extendAdminHold pushes it out while somebody is still there. Reads none when the gate is open, and while a flow holds it: a run names its own window and ends on its own.
    audioLock: bool  # True while the audio device is mid-transition. Read-only, and it refuses everyone including admins: it guards the device, not permissions.
    isAdmin: bool  # Whether this connection holds admin rights. Per-connection, so it is only ever sent to the client it describes.
    flow: FlowStatus  # What the server's one flow slot is doing. Always readable: an idle slot says so rather than reading as nothing. Read-only — startFlow and stopFlow change it.
    schedule: list[ScheduleEntry]  # The weekly calendar this server keeps: every flow that may be run, in the order they were written. State rather than a one-shot list, because it is edited while clients are connected. Read-only — saveFlow and deleteFlow move it. It lives here because it is persistent, and because whether a track may be deleted depends on whether a flow still names it, which only whoever holds both can answer.
    clockOffsetSec: float  # How far ahead of standard time the church clock runs, in seconds. Negative means behind. Every instant on this wire is read against it, so writing it moves the whole schedule. Refused with adminLocked while the gate is held: a flow holds the gate for its whole run, which makes it impossible to move the clock out from under music that is already playing. Survives restarts.
    console: list[ConsoleInput]  # The inputs this server drives, in the order to show them, each with what the mixing desk itself reports for it. Read-only: enableConsoleInput changes the desk, and the desk's next answer changes this. Each starts unknown and falls back to unknown when the desk stops answering, so a dead console never wears a live face.


class WriteRequest(TypedDict):
    """One write targets one attribute. See ATTRIBUTES for the value type."""
    field: str
    value: object


class AuthenticateArgs(TypedDict):
    """
    Claim admin rights for this connection. Success shows up as isAdmin in a
    state patch; failure comes back as rejected with invalidPassword.
    """
    password: str


class EnableConsoleInputArgs(TypedDict):
    """
    Switch a mixing console input on. Not subject to the audio lock, and open
    to anyone the admin lock is not holding back — the console keeps no
    protected state. It reports nothing back, so there is no attribute to
    read.
    """
    input: str  # An id from the console attribute


class InitializeConsoleArgs(TypedDict):
    """
    Put the mixing desk into the state a service starts from: every input on,
    the mute group released, and the masters at their levels. The steps are
    ordered and paced by the server, because raising the main before the
    matrix has come down would let the room hear everything at once. Like
    enableConsoleInput it takes no audio lock and reports nothing back — the
    desk's own answers arrive through the console attribute. Takes a few
    hundred milliseconds to finish, so a client should not expect the reading
    to have changed by the time the call returns.
    """
    pass


class StartFlowArgs(TypedDict):
    """
    Hand the server one run, spelled out in instants, and it owns that run to
    the end: it keeps to the wall clock, restores the user's song afterwards,
    and cleans up however it finishes. This is the primitive underneath
    startScheduledFlow, which is how a calendar entry is normally run — reach
    for this one only to run something that is not on the calendar. Every flow
    holds the admin gate for a window it names, and music must finish inside
    that window: running past the unlock is refused with musicOutsideLock
    rather than played on an open panel, as is music that would end before the
    gate even engages, since it could never sound. A timeline that begins
    before the window is accepted — the sound starts with the lock and joins
    the timeline where it already is, the opening cut exactly like a late
    start. Only one flow runs at a time. A flow whose window has already
    closed is refused with windowPassed rather than accepted and completed
    instantly, so pressing start never looks like nothing happened.
    """
    id: str  # The caller's own id for this flow, uninterpreted and handed back on every status.
    name: str  # Display name, e.g. '수요 예배'
    lock: FlowLock  # The window this run holds the admin gate for
    parts: list[FlowPart]  # What this run does besides holding the gate. Empty for a lock-only flow; at most one of each kind.


class StopFlowArgs(TypedDict):
    """
    End the running flow now: stop playback, restore the user's song, release
    the admin lock.
    """
    pass


class ExtendAdminHoldArgs(TypedDict):
    """
    Pushes back when the gate lapses, by thirty minutes, never past an hour
    from now. So it can be pressed as often as somebody is there to press it,
    and the moment nobody is, the hour starts running out. Refused with
    adminUnlocked when no gate is held, and with flowActive while a flow holds
    one — a run's window is the run's.
    """
    pass


class SaveFlowArgs(TypedDict):
    """
    Create or replace one calendar entry, and write the calendar to disk.
    Validated the way the file is at boot, so an entry saved here cannot be
    one the next boot refuses. Refused with musicOutsideLock if the music
    could not finish inside the gate window, and with unknownTrack if it names
    a track this server does not have — both caught while somebody is still
    editing rather than at 19:30 on a Wednesday.
    """
    flow: ScheduleEntry  # The entry to write. A known id replaces in place; a new one is appended.


class DeleteFlowArgs(TypedDict):
    """
    Remove one calendar entry. A run already in flight is untouched — it
    stopped being this entry the moment it started.
    """
    id: str  # Entry id from the schedule attribute


class StartScheduledFlowArgs(TypedDict):
    """
    Run a calendar entry now. The server turns its wall-clock times into
    instants against church time and the day it is being started on, then runs
    it exactly as startFlow would. Refused with windowPassed if today is not
    one of its weekdays.
    """
    id: str  # Entry id from the schedule attribute


class SkipFlowArgs(TypedDict):
    """
    Pass over today's occurrence of an auto-start entry. Next week stands.
    Forgotten at the end of the day and on restart — a skip is about one
    service, not a setting.
    """
    id: str  # Entry id from the schedule attribute


class SetTrackVolumeArgs(TypedDict):
    """
    Set the level a track sounds at, kept across restarts. Applies from the
    next time the track is chosen — it does not move a level that is already
    playing, which is what the volume attribute is for.
    """
    id: str  # Track id from ready.tracks
    volume: float  # 0-100


class SelectTrackArgs(TypedDict):
    """
    Put a library track on the deck, paused at its start, at its own level —
    the same act as writing the song attribute, for the tracks that are not
    among ready.songs. Playing it is a separate write to playback. Refused
    with adminUnlocked unless the gate is held: while the panel is open it
    shows the song it thinks is playing, and a track it never chose would make
    that a lie. Releasing the gate takes the track off and puts the user's
    song back.
    """
    id: str  # Track id from ready.tracks


class InvokeRequest(TypedDict):
    """One invoke runs one command. See the *Args types for its arguments."""
    command: str
    args: dict


ATTRIBUTES: dict[str, dict] = {
    "playback": {"access": "rw", "permission": "any"},
    "volume": {"access": "rw", "permission": "any", "range": (0, 100)},
    "mute": {"access": "rw", "permission": "any"},
    "loop": {"access": "rw", "permission": "admin"},
    "trackVolumes": {"access": "ro"},
    "deck": {"access": "ro"},
    "unlockWhenDone": {"access": "rw", "permission": "admin"},
    "musicEndsAt": {"access": "rw", "permission": "admin"},
    "song": {"access": "rw", "permission": "any"},
    "adminLock": {"access": "rw", "permission": "admin"},
    "adminHold": {"access": "ro"},
    "audioLock": {"access": "ro"},
    "isAdmin": {"access": "ro"},
    "flow": {"access": "ro"},
    "schedule": {"access": "ro"},
    "clockOffsetSec": {"access": "rw", "permission": "admin", "range": (-3600, 3600)},
    "console": {"access": "ro"},
}

COMMANDS: dict[str, dict] = {
    "authenticate": {"permission": "any"},
    "enableConsoleInput": {"permission": "any"},
    "initializeConsole": {"permission": "any"},
    "startFlow": {"permission": "admin"},
    "stopFlow": {"permission": "admin"},
    "extendAdminHold": {"permission": "admin"},
    "saveFlow": {"permission": "admin"},
    "deleteFlow": {"permission": "admin"},
    "startScheduledFlow": {"permission": "admin"},
    "skipFlow": {"permission": "admin"},
    "setTrackVolume": {"permission": "admin"},
    "selectTrack": {"permission": "admin"},
}


class C2S(str, Enum):
    """C2S event names"""
    HELLO = "hello"
    READ = "read"
    WRITE = "write"
    INVOKE = "invoke"


class S2C(str, Enum):
    """S2C event names"""
    READY = "ready"
    STATE = "state"
    REJECTED = "rejected"
    PING = "ping"


class HelloPayload(TypedDict):
    """
    First message after connecting. Identifies the client and declares the
    protocol version it speaks. The server answers with ready, then a full
    state.
    """
    client: str  # Human-readable device name shown to the admin, e.g. '본당 태블릿'
    protocolVersion: float


class ReadPayload(TypedDict):
    """
    Ask for every attribute value, for example after waking from background.
    There is no field selection: the whole state is small, and one shape is
    easier to keep honest than two.
    """
    pass


class ReadyPayload(TypedDict):
    """
    Answer to hello: what this server speaks, what it supports, and the fixed
    track library. When accepted is false the client is on an incompatible
    protocol version — it should tell the user to update. State still arrives,
    but writes and invokes are refused with protocolMismatch.
    """
    protocolVersion: float  # Version this server speaks
    accepted: bool
    attributes: list[str]  # Attributes this server implements. Hide controls for anything absent.
    commands: list[str]  # Commands this server implements. Hide controls for anything absent.
    songs: list[Song]  # Songs a user may select, with the names to show, in the order to show them. How many there are is the server's to say, so a client draws one control per entry rather than assuming a count — adding a song is then a server change alone. Fixed at boot.
    tracks: list[Track]  # Track library for flows, fixed at boot
    contact: Contact  # Who a client should tell the user to call when something is broken. Fixed at boot.


class RejectedPayload(TypedDict):
    """
    A write or invoke was refused. Sent only to the client that issued it, so
    it can say why instead of appearing to do nothing.
    """
    target: str  # Attribute or command name that was refused
    reason: RejectReason


class PingPayload(TypedDict):
    """
    Application-level heartbeat, carrying the server's own church time. A
    client draws 'now' from this rather than from its own clock — the point of
    the offset is that local clocks disagree, and a countdown drawn against a
    wrong one would be wrong in exactly the situation this exists for.
    """
    at: str  # Church time at the moment this was sent
    offsetSec: float  # The correction in force at that same moment, so standard time is recoverable exactly. A client holds the offset as an attribute too, but that one can have moved since this beat was sent — taking a stale one back out of `at` is how a clock ends up wrong by the size of the last correction.
