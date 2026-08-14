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
    DEVICE_BUSY = "deviceBusy"
    UNKNOWN_TRACK = "unknownTrack"
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


class Track(TypedDict):
    """A playable library entry. File paths never leave the server."""
    id: str  # Stable identifier used by startFlow
    title: str  # Human-readable name
    durationSec: float  # Length in seconds, measured from the file
    volume: float  # The level this track sounds at when nobody says otherwise, 0-100. Sent so an editor can offer it as the starting value when someone adds this track to a flow; the flow itself then carries a level for every track it plays.


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
    name: str
    startsAt: str  # Instant its first part begins


class FlowStatusPlaying(TypedDict):
    """The flow's music is sounding"""
    phase: Literal["playing"]
    name: str
    track: FlowTrack
    endsAt: str  # Instant the music finishes


class FlowStatusHolding(TypedDict):
    """Nothing is sounding, but the flow still holds the admin lock"""
    phase: Literal["holding"]
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
    playback: PlaybackState  # Whether the deck is playing. Writing it fades in or out and holds the audio lock for the length of the fade.
    volume: float  # Output volume. Applies immediately, so it is safe to write continuously while dragging a fader.
    mute: MuteState  # Whether output is muted
    song: str  # Id of the selected song, one of the ids listed in ready.songs. Writing it fades out, switches, and restores that song's remembered position, paused. It is an id rather than a fixed set because which songs exist, and what they are called, is the server's to say.
    adminLock: bool  # Global gate on non-admin writes. Any admin may release it, it survives disconnects, and it is cleared by a restart.
    audioLock: bool  # True while the audio device is mid-transition. Read-only, and it refuses everyone including admins: it guards the device, not permissions.
    isAdmin: bool  # Whether this connection holds admin rights. Per-connection, so it is only ever sent to the client it describes.
    flow: FlowStatus  # What the server's one flow slot is doing. Always readable: an idle slot says so rather than reading as nothing. Read-only — startFlow and stopFlow change it.
    clockOffsetSec: float  # How far ahead of standard time the church clock runs, in seconds. Negative means behind. Every instant on this wire is read against it, so writing it moves the whole schedule. Refused with adminLocked while the gate is held: a flow holds the gate for its whole run, which makes it impossible to move the clock out from under music that is already playing. Survives restarts.
    console: list[ConsoleInput]  # The inputs this server drives, in the order to show them, each with what the mixing desk itself reports for it. Read-only: enableConsoleInput changes the desk, and the desk's next answer changes this. Each starts unknown and falls back to unknown when the desk stops answering, so a dead console never wears a live face.


class StatePatch(TypedDict, total=False):
    """Attributes that changed. Absent means unchanged."""
    playback: PlaybackState  # Whether the deck is playing. Writing it fades in or out and holds the audio lock for the length of the fade.
    volume: float  # Output volume. Applies immediately, so it is safe to write continuously while dragging a fader.
    mute: MuteState  # Whether output is muted
    song: str  # Id of the selected song, one of the ids listed in ready.songs. Writing it fades out, switches, and restores that song's remembered position, paused. It is an id rather than a fixed set because which songs exist, and what they are called, is the server's to say.
    adminLock: bool  # Global gate on non-admin writes. Any admin may release it, it survives disconnects, and it is cleared by a restart.
    audioLock: bool  # True while the audio device is mid-transition. Read-only, and it refuses everyone including admins: it guards the device, not permissions.
    isAdmin: bool  # Whether this connection holds admin rights. Per-connection, so it is only ever sent to the client it describes.
    flow: FlowStatus  # What the server's one flow slot is doing. Always readable: an idle slot says so rather than reading as nothing. Read-only — startFlow and stopFlow change it.
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
    Hand the server one flow to run, and it owns that run to the end: it keeps
    to the wall clock, restores the user's song afterwards, and cleans up
    however it finishes. The schedule this came from stays with the caller —
    the server holds no flow definitions and no calendar, it only executes
    what it is given. Every flow holds the admin gate for a window it names,
    and music must finish inside that window: running past the unlock is
    refused with musicOutsideLock rather than played on an open panel, as is
    music that would end before the gate even engages, since it could never
    sound. A timeline that begins before the window is accepted — the sound
    starts with the lock and joins the timeline where it already is, the
    opening cut exactly like a late start. Only one flow runs at a time. A
    flow whose window has already closed is refused with windowPassed rather
    than accepted and completed instantly, so pressing start never looks like
    nothing happened.
    """
    name: str  # Display name, e.g. '수요 예배'
    lock: FlowLock  # The window this run holds the admin gate for
    parts: list[FlowPart]  # What this run does besides holding the gate. Empty for a lock-only flow; at most one of each kind.


class StopFlowArgs(TypedDict):
    """
    End the running flow now: stop playback, restore the user's song, release
    the admin lock.
    """
    pass


class InvokeRequest(TypedDict):
    """One invoke runs one command. See the *Args types for its arguments."""
    command: str
    args: dict


ATTRIBUTES: dict[str, dict] = {
    "playback": {"access": "rw", "permission": "any"},
    "volume": {"access": "rw", "permission": "any", "range": (0, 100)},
    "mute": {"access": "rw", "permission": "any"},
    "song": {"access": "rw", "permission": "any"},
    "adminLock": {"access": "rw", "permission": "admin"},
    "audioLock": {"access": "ro"},
    "isAdmin": {"access": "ro"},
    "flow": {"access": "ro"},
    "clockOffsetSec": {"access": "rw", "permission": "admin", "range": (-3600, 3600)},
    "console": {"access": "ro"},
}

COMMANDS: dict[str, dict] = {
    "authenticate": {"permission": "any"},
    "enableConsoleInput": {"permission": "any"},
    "initializeConsole": {"permission": "any"},
    "startFlow": {"permission": "admin"},
    "stopFlow": {"permission": "admin"},
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
