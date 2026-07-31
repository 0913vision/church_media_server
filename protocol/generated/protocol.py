# Generated from protocol/protocol.json — do not edit by hand.
# Run `npm run gen-protocol` in church-media-server after changing the spec.

from __future__ import annotations

from enum import Enum
from typing import TypedDict

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


class SongType(str, Enum):
    """Selectable song in the two-song system users control directly"""
    SLOW = "slow"
    FAST = "fast"


class ConsoleInput(str, Enum):
    """Mixing console input. Inputs are independent, not alternatives."""
    MIC = "mic"
    AUX = "aux"


class FlowPhase(str, Enum):
    """Stage of a running scheduled flow"""
    WAITING_LOCK = "waitingLock"
    PLAYING = "playing"
    HOLDING = "holding"


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
    PROTOCOL_MISMATCH = "protocolMismatch"


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


class Flow(TypedDict):
    """The scheduled flow the server is running"""
    name: str  # Display name supplied by the caller
    phase: FlowPhase
    track: FlowTrack | None  # Null unless phase is playing
    endsAt: str | None  # When the track sequence finishes; null for a lock-only flow
    unlockAt: str  # When the admin lock releases. Independent of endsAt.


class State(TypedDict):
    """Attribute values, all present."""
    playback: PlaybackState  # Whether the deck is playing. Writing it fades in or out and holds the audio lock for the length of the fade.
    volume: float  # Output volume. Applies immediately, so it is safe to write continuously while dragging a fader.
    mute: MuteState  # Whether output is muted
    song: SongType  # Selected song. Writing it fades out, switches, and restores that song's remembered position, paused.
    adminLock: bool  # Global gate on non-admin writes. Any admin may release it, it survives disconnects, and it is cleared by a restart.
    audioLock: bool  # True while the audio device is mid-transition. Read-only, and it refuses everyone including admins: it guards the device, not permissions.
    isAdmin: bool  # Whether this connection holds admin rights. Per-connection, so it is only ever sent to the client it describes.
    flow: Flow | None  # The scheduled flow the server is running, or null when there is none. Read-only: startFlow and stopFlow change it.


class StatePatch(TypedDict, total=False):
    """Attributes that changed. Absent means unchanged."""
    playback: PlaybackState  # Whether the deck is playing. Writing it fades in or out and holds the audio lock for the length of the fade.
    volume: float  # Output volume. Applies immediately, so it is safe to write continuously while dragging a fader.
    mute: MuteState  # Whether output is muted
    song: SongType  # Selected song. Writing it fades out, switches, and restores that song's remembered position, paused.
    adminLock: bool  # Global gate on non-admin writes. Any admin may release it, it survives disconnects, and it is cleared by a restart.
    audioLock: bool  # True while the audio device is mid-transition. Read-only, and it refuses everyone including admins: it guards the device, not permissions.
    isAdmin: bool  # Whether this connection holds admin rights. Per-connection, so it is only ever sent to the client it describes.
    flow: Flow | None  # The scheduled flow the server is running, or null when there is none. Read-only: startFlow and stopFlow change it.


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
    Switch a mixing console input on. Not subject to the audio lock. The
    console reports nothing back, so there is no attribute to read.
    """
    input: ConsoleInput


class StartFlowArgs(TypedDict):
    """
    Hand the server a whole scheduled flow to run: it engages the admin lock
    at lockAt, plays the sequence so it finishes at endsAt (joining
    mid-sequence if started late), restores the user's song, and releases the
    lock at unlockAt. One flow at a time.
    """
    name: str  # Display name, e.g. '수요 예배'
    tracks: list[str]  # Track ids in play order. Empty for a lock-only flow.
    lockAt: str  # When to engage the admin lock. Already past means immediately.
    endsAt: str | None  # When the last track must finish. Required when tracks is non-empty.
    unlockAt: str  # When to release the admin lock. Must be after lockAt.


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
    "enableConsoleInput": {"permission": "admin"},
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
    Ask for attribute values, for example after waking from background. Omit
    fields to read everything.
    """
    fields: list[str] | None  # Attribute names to read, or null for all


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
    tracks: list[Track]  # Track library, fixed at boot


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
