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

PROTOCOL_VERSION = 1


class PlaybackState(str, Enum):
    """Whether the audio deck is sounding"""
    PAUSED = "paused"
    PLAYING = "playing"


class MuteState(str, Enum):
    """Whether output is muted"""
    UNMUTED = "unmuted"
    MUTED = "muted"


class ConsoleInput(str, Enum):
    """Mixing console input. Inputs are independent, not alternatives."""
    MIC = "mic"
    AUX = "aux"


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
    PROTOCOL_MISMATCH = "protocolMismatch"


class Song(TypedDict):
    """
    A song a user can select and leave looping. The server names these, so
    renaming one — or adding another — needs no client release.
    """
    id: str  # Value to write to the song attribute
    title: str  # Human-readable name to show


class Track(TypedDict):
    """A playable library entry. File paths never leave the server."""
    id: str  # Stable identifier used by startFlow
    title: str  # Human-readable name
    durationSec: float  # Length in seconds, measured from the file


class FlowTrack(TypedDict):
    """Which track of a flow is sounding right now"""
    title: str
    index: float  # 1-based position in the sequence
    total: float


class FlowPartMusic(TypedDict):
    """
    Play these tracks in order so the last one finishes at endsAt. Started
    late, the server joins the timeline part-way through.
    """
    kind: Literal["music"]
    tracks: list[str]  # Track ids in play order
    endsAt: str  # When the last track must finish


class FlowPartLock(TypedDict):
    """
    Hold the global admin gate for this window. Releasing is its own step:
    music ending does not release the lock.
    """
    kind: Literal["lock"]
    at: str  # When to engage the lock. Already past means immediately.
    until: str  # When to release it. Must be after at.


"""
One part of a flow. A flow is a set of these, so a run can play music, hold
the admin lock, or both — and a new capability later is a new kind rather than
a new command.
"""
FlowPart = FlowPartMusic | FlowPartLock


class FlowStatusIdle(TypedDict):
    """No flow is running"""
    phase: Literal["idle"]


class FlowStatusWaiting(TypedDict):
    """A flow is accepted but none of its parts has started yet"""
    phase: Literal["waiting"]
    name: str
    startsAt: str  # When its first part begins


class FlowStatusPlaying(TypedDict):
    """The flow's music is sounding"""
    phase: Literal["playing"]
    name: str
    track: FlowTrack
    endsAt: str  # When the music finishes


class FlowStatusHolding(TypedDict):
    """Nothing is sounding, but the flow still holds the admin lock"""
    phase: Literal["holding"]
    name: str
    unlockAt: str  # When the lock releases


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
    input: ConsoleInput


class StartFlowArgs(TypedDict):
    """
    Hand the server one flow to run, and it owns that run to the end: it keeps
    to the wall clock, restores the user's song afterwards, and cleans up
    however it finishes. The schedule this came from stays with the caller —
    the server holds no flow definitions and no calendar, it only executes
    what it is given. A flow is a set of parts, at least one, and only one
    flow runs at a time. A flow whose every part has already finished is
    refused with windowPassed rather than accepted and completed instantly, so
    pressing start never looks like nothing happened.
    """
    name: str  # Display name, e.g. '수요 예배'
    parts: list[FlowPart]  # What this run should do. At least one part, and at most one of each kind.


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
}

COMMANDS: dict[str, dict] = {
    "authenticate": {"permission": "any"},
    "enableConsoleInput": {"permission": "any"},
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
    songs: list[Song]  # Songs a user may select, with the names to show. Fixed at boot.
    tracks: list[Track]  # Track library for flows, fixed at boot


class RejectedPayload(TypedDict):
    """
    A write or invoke was refused. Sent only to the client that issued it, so
    it can say why instead of appearing to do nothing.
    """
    target: str  # Attribute or command name that was refused
    reason: RejectReason


class PingPayload(TypedDict):
    """Application-level heartbeat"""
    pass
