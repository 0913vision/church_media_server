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
    DECK_SONG = "deckSong"
    TRACK_IN_USE = "trackInUse"
    UNKNOWN_UPLOAD = "unknownUpload"
    TITLE_TAKEN = "titleTaken"
    TOO_LARGE = "tooLarge"
    FETCH_FAILED = "fetchFailed"
    FETCH_BUSY = "fetchBusy"
    CONSOLE_HELD = "consoleHeld"
    LEVEL_MATCHING = "levelMatching"
    DECK_PLAYING = "deckPlaying"
    DECK_MUTED = "deckMuted"
    NOT_MEASURING = "notMeasuring"
    PROTOCOL_MISMATCH = "protocolMismatch"


class LevelFailure(str, Enum):
    """
    Why a level measurement ended without an answer. Nothing about the track
    was changed, and the deck and the desk were put back.
    """
    STOPPED = "stopped"
    GATE_RELEASED = "gateReleased"
    DECK_TAKEN = "deckTaken"
    DECK_FAILED = "deckFailed"
    DESK_MOVED = "deskMoved"
    DESK_SILENT = "deskSilent"
    DESK_HELD = "deskHeld"
    NO_SIGNAL = "noSignal"


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
    volume: float  # The level it sounds at, 0-100. One setting serving three uses: what a song returns to when it is chosen, what a library track is put on at, and what a flow editor offers when this track joins a service. A flow carries its own level for every track it plays, so changing this never rewrites a service already written.


class ScheduledTrack(TypedDict):
    """
    One track in a flow's music sequence, with the level it plays at. The
    level is always given: an editor starts it at the track's own volume and
    the person can lower or raise it there, so what a flow will sound like is
    decided when it is written rather than inherited from whatever the panel
    was left at.
    """
    id: str  # Track id from the tracks attribute
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


class TrackSourceUpload(TypedDict):
    """An mp3 already sent to POST /uploads"""
    kind: Literal["upload"]
    upload: str  # The id POST /uploads answered with. Good once, and for ten minutes.


class TrackSourceYoutube(TypedDict):
    """
    A YouTube video, whose audio the server fetches itself as an mp3. One
    video, never a playlist.
    """
    kind: Literal["youtube"]
    url: str  # A youtube.com or youtu.be address


"""
Where the audio for a new track comes from. A new way of bringing audio in is
a new kind here rather than a new command.
"""
TrackSource = TrackSourceUpload | TrackSourceYoutube


class TrackFetchIdle(TypedDict):
    """Nothing is being fetched"""
    kind: Literal["idle"]


class TrackFetchFetching(TypedDict):
    """A video's audio is on its way"""
    kind: Literal["fetching"]
    title: str  # The title the track will have
    progress: FetchProgress  # How far it has got


"""
What the server is fetching from outside to make a track. Fetching takes
minutes where an upload takes a moment, so it is state: every screen can say
that a track is on its way.
"""
TrackFetch = TrackFetchIdle | TrackFetchFetching


class LevelSpanWhole(TypedDict):
    """From its start to its end"""
    kind: Literal["whole"]


class LevelSpanFirst(TypedDict):
    """From its start, for this long"""
    kind: Literal["first"]
    sec: float  # How long, in seconds. More than zero; longer than the track is the whole track.


"""
How much of a track a level measurement plays. The whole track is the full
answer; the front of a long one that keeps repeating itself is the same answer
sooner.
"""
LevelSpan = LevelSpanWhole | LevelSpanFirst


class LevelMatchIdle(TypedDict):
    """Nothing has been measured since the server started"""
    phase: Literal["idle"]


class LevelMatchMeasuring(TypedDict):
    """A track is being measured. Sent once a second while it runs."""
    phase: Literal["measuring"]
    track: str  # Track id
    targetDb: float  # The average it was asked to land on, in dB under the desk's full scale
    elapsedSec: float  # How much has been played, whole seconds. Zero while the desk is being set aside.
    totalSec: float  # How much will be played, in seconds
    levelDb: float  # What the meter has read over the last few seconds, in dB under full scale, one decimal. Silence reads -120.


class LevelMatchDone(TypedDict):
    """
    Measured, and the track's level was moved. The new level is in tracks, in
    the same patch.
    """
    phase: Literal["done"]
    track: str  # Track id
    targetDb: float  # The average it was asked to land on
    averageDb: float  # The average the meter read at the old level, one decimal
    volumeBefore: float  # The level it was measured at
    volumeAfter: float  # The level it now has


class LevelMatchOutOfReach(TypedDict):
    """
    Measured, but the target needs a level the deck does not have — over 100,
    or under 1. Nothing was changed.
    """
    phase: Literal["outOfReach"]
    track: str  # Track id
    targetDb: float  # The average it was asked to land on
    averageDb: float  # The average the meter read, one decimal
    volumeBefore: float  # The level it was measured at, and still has
    volumeNeeded: float  # The level the target would take, one decimal


class LevelMatchFailed(TypedDict):
    """Ended without an answer. Nothing was changed."""
    phase: Literal["failed"]
    track: str  # Track id
    why: LevelFailure


"""
What the server's one level measurement is doing, or how the last one ended. A
measurement plays a track to the desk with the music player's input switched
off there, reads that input's meter, and moves the track's level so its
average lands on a target. It takes minutes, so it is state: every screen can
say the deck is in use and why. What one ended with stays until the next
starts; a restart forgets it.
"""
LevelMatch = LevelMatchIdle | LevelMatchMeasuring | LevelMatchDone | LevelMatchOutOfReach | LevelMatchFailed


class FetchProgressStarting(TypedDict):
    """Nothing has arrived yet: the video is being looked up"""
    stage: Literal["starting"]


class FetchProgressDownloading(TypedDict):
    """The audio is arriving"""
    stage: Literal["downloading"]
    percent: float  # How much has arrived, 0-100, whole numbers


class FetchProgressConverting(TypedDict):
    """All of it has arrived and is being made into an mp3"""
    stage: Literal["converting"]


"""
How far a fetch has got. A stage rather than a bare percentage, because the
last stage has none to give: the audio has all arrived and is being made into
an mp3, and the converter says nothing about how far along it is. Sent at most
once a second.
"""
FetchProgress = FetchProgressStarting | FetchProgressDownloading | FetchProgressConverting


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
    id: str  # Track id from the tracks attribute


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
    playback: PlaybackState  # Whether the deck is playing. Writing it fades in or out and holds the audio lock for the length of the fade. Refused with flowActive while a flow's music is sounding: the run was handed the deck and puts it back itself. A flow that only holds the gate is keeping the panel out, not using the deck, so this stays writable then. Refused with levelMatching while a level measurement has the deck.
    volume: float  # Output volume, 0-100, whole numbers — a value with a fraction is rounded rather than refused, since a dragged fader sends the ratio of a pixel to a width. Reports what is *sounding*: while a run plays, this is the level that run was written with, not the one the panel was left at, and the panel's own level comes back with its song. Applies immediately, so it is safe to write continuously while dragging a fader. Refused with flowActive while a flow's music is sounding: the run was handed the deck and puts it back itself. A flow that only holds the gate is keeping the panel out, not using the deck, so this stays writable then. Refused with levelMatching while a level measurement has the deck.
    mute: MuteState  # Whether output is muted. Refused with flowActive while a flow's music is sounding: the run was handed the deck and puts it back itself. A flow that only holds the gate is keeping the panel out, not using the deck, so this stays writable then. Refused with levelMatching while a level measurement has the deck.
    loop: bool  # Whether what is on the deck repeats. Always true unless the gate is held: the panel's two songs are meant to run under a service without ending, and nobody at the panel should be able to stop that. Writable only while the gate is held, and refused with flowActive while a run's music is sounding — it describes what is on the deck, and a run's track made to repeat is a timeline that never finishes. A run merely holding the gate is not using the deck, so this stays writable then. Refused with levelMatching while a level measurement has the deck. Reset to true when the gate opens — like everything else the gate changes, it goes back to the user's state.
    tracks: list[Track]  # Every track the server can play, each with the level it sounds at, in the order to show them. State rather than part of ready, because tracks are added, renamed and deleted while clients are connected. Read-only — addTrack, setTrackVolume, renameTrack and deleteTrack move it.
    trackFetch: TrackFetch  # Whether a track is being fetched from YouTube right now. Changes in the same patch as the tracks it produced, so a screen never sees the fetch end before the track appears. Read-only — addTrack moves it.
    levelMatch: LevelMatch  # What the level measurement is doing, or how the last one ended. Changes in the same patch as the tracks it moved, so a screen never sees it done before the new level. Read-only — matchTrackLevel and stopLevelMatch move it.
    deck: DeckSource  # What is on the deck: the panel's own song, or a library track an admin put on. Read-only — song and playTrack are what move it.
    unlockWhenDone: bool  # Whether the music stopping also releases the gate, restoring the user's song on the way out. For putting one piece on and walking away. 'Stopping' means either the track running out or musicEndsAt arriving — with loop on, only the latter can ever happen. Writable only while a *person* is holding the gate — during a run the gate is the run's and there is no hold to arm, so this is refused with flowActive. False again once the gate opens.
    musicEndsAt: MusicEnd  # When the music an admin put on should stop. This is what makes a repeating track finite: looping audio has no end of its own, so without it a gate held over that music is held until somebody comes back. A client should ask the moment loop is switched on, and while the answer is undecided say plainly — in words, not as an alarm — that nothing will stop by itself. Reaching an instant stops the music and puts the user's song back; the gate goes too if unlockWhenDone is on. Writable only while a *person* is holding the gate, for the same reason unlockWhenDone is; refused with flowActive during a run. Undecided again once the gate opens.
    song: str  # Id of the selected song, one of the ids listed in ready.songs. Writing it fades out, switches, and restores that song's remembered position, paused. It is an id rather than a fixed set because which songs exist, and what they are called, is the server's to say. Refused with flowActive while a flow's music is sounding: the run was handed the deck and puts it back itself. A flow that only holds the gate is keeping the panel out, not using the deck, so this stays writable then. Refused with levelMatching while a level measurement has the deck.
    adminLock: bool  # Global gate on non-admin writes. Any admin may release it, it survives disconnects, and it is cleared by a restart. A gate a person engaged also lapses by itself — see adminHold. A run engages the same gate, and a run starting over a person's hold takes it: a scheduled service outranks an ad-hoc lock, and the hold stops counting from that moment rather than expiring later under music that is playing. Releasing it, or a run taking it, ends a level measurement, which puts the deck and the desk back on its way out.
    adminHold: Deadline  # When a gate a person engaged lapses by itself. It waits for music that has an end — a track that will finish, or one told when to stop — because releasing under a song that is still sounding opens the panel mid-music. Never more than an hour ahead: a panel locked and forgotten is a panel nobody in the building can use, and the person who locked it has usually gone home. Lapsing does what releasing does — the user's song comes back with it. extendAdminHold pushes it out while somebody is still there. Reads none when the gate is open, and while a flow holds it: a run names its own window and ends on its own.
    audioLock: bool  # True while the audio device is mid-transition. Read-only, and it refuses everyone including admins: it guards the device, not permissions.
    isAdmin: bool  # Whether this connection holds admin rights. Per-connection, so it is only ever sent to the client it describes.
    flow: FlowStatus  # What the server's one flow slot is doing. Always readable: an idle slot says so rather than reading as nothing. Read-only — startFlow and stopFlow change it.
    schedule: list[ScheduleEntry]  # The weekly calendar this server keeps: every flow that may be run, in the order they were written. State rather than a one-shot list, because it is edited while clients are connected. Read-only — saveFlow and deleteFlow move it. It lives here because it is persistent, and because whether a track may be deleted depends on whether a flow still names it, which only whoever holds both can answer.
    clockOffsetSec: float  # How far ahead of standard time the church clock runs, in seconds, kept to the millisecond — a correction set by pressing a key on the wall clock's flip is rarely a whole second. Negative means behind. Every instant on this wire is read against it, so writing it moves the whole schedule. Refused with adminLocked while the gate is held: a flow holds the gate for its whole run, which makes it impossible to move the clock out from under music that is already playing. Survives restarts.
    console: list[ConsoleInput]  # The inputs this server drives, in the order to show them, each with what the mixing desk itself reports for it. Read-only: enableConsoleInput changes the desk, and the desk's next answer changes this. Each starts unknown and falls back to unknown when the desk stops answering, so a dead console never wears a live face.


class StatePatch(TypedDict, total=False):
    """Attributes that changed. Absent means unchanged."""
    playback: PlaybackState  # Whether the deck is playing. Writing it fades in or out and holds the audio lock for the length of the fade. Refused with flowActive while a flow's music is sounding: the run was handed the deck and puts it back itself. A flow that only holds the gate is keeping the panel out, not using the deck, so this stays writable then. Refused with levelMatching while a level measurement has the deck.
    volume: float  # Output volume, 0-100, whole numbers — a value with a fraction is rounded rather than refused, since a dragged fader sends the ratio of a pixel to a width. Reports what is *sounding*: while a run plays, this is the level that run was written with, not the one the panel was left at, and the panel's own level comes back with its song. Applies immediately, so it is safe to write continuously while dragging a fader. Refused with flowActive while a flow's music is sounding: the run was handed the deck and puts it back itself. A flow that only holds the gate is keeping the panel out, not using the deck, so this stays writable then. Refused with levelMatching while a level measurement has the deck.
    mute: MuteState  # Whether output is muted. Refused with flowActive while a flow's music is sounding: the run was handed the deck and puts it back itself. A flow that only holds the gate is keeping the panel out, not using the deck, so this stays writable then. Refused with levelMatching while a level measurement has the deck.
    loop: bool  # Whether what is on the deck repeats. Always true unless the gate is held: the panel's two songs are meant to run under a service without ending, and nobody at the panel should be able to stop that. Writable only while the gate is held, and refused with flowActive while a run's music is sounding — it describes what is on the deck, and a run's track made to repeat is a timeline that never finishes. A run merely holding the gate is not using the deck, so this stays writable then. Refused with levelMatching while a level measurement has the deck. Reset to true when the gate opens — like everything else the gate changes, it goes back to the user's state.
    tracks: list[Track]  # Every track the server can play, each with the level it sounds at, in the order to show them. State rather than part of ready, because tracks are added, renamed and deleted while clients are connected. Read-only — addTrack, setTrackVolume, renameTrack and deleteTrack move it.
    trackFetch: TrackFetch  # Whether a track is being fetched from YouTube right now. Changes in the same patch as the tracks it produced, so a screen never sees the fetch end before the track appears. Read-only — addTrack moves it.
    levelMatch: LevelMatch  # What the level measurement is doing, or how the last one ended. Changes in the same patch as the tracks it moved, so a screen never sees it done before the new level. Read-only — matchTrackLevel and stopLevelMatch move it.
    deck: DeckSource  # What is on the deck: the panel's own song, or a library track an admin put on. Read-only — song and playTrack are what move it.
    unlockWhenDone: bool  # Whether the music stopping also releases the gate, restoring the user's song on the way out. For putting one piece on and walking away. 'Stopping' means either the track running out or musicEndsAt arriving — with loop on, only the latter can ever happen. Writable only while a *person* is holding the gate — during a run the gate is the run's and there is no hold to arm, so this is refused with flowActive. False again once the gate opens.
    musicEndsAt: MusicEnd  # When the music an admin put on should stop. This is what makes a repeating track finite: looping audio has no end of its own, so without it a gate held over that music is held until somebody comes back. A client should ask the moment loop is switched on, and while the answer is undecided say plainly — in words, not as an alarm — that nothing will stop by itself. Reaching an instant stops the music and puts the user's song back; the gate goes too if unlockWhenDone is on. Writable only while a *person* is holding the gate, for the same reason unlockWhenDone is; refused with flowActive during a run. Undecided again once the gate opens.
    song: str  # Id of the selected song, one of the ids listed in ready.songs. Writing it fades out, switches, and restores that song's remembered position, paused. It is an id rather than a fixed set because which songs exist, and what they are called, is the server's to say. Refused with flowActive while a flow's music is sounding: the run was handed the deck and puts it back itself. A flow that only holds the gate is keeping the panel out, not using the deck, so this stays writable then. Refused with levelMatching while a level measurement has the deck.
    adminLock: bool  # Global gate on non-admin writes. Any admin may release it, it survives disconnects, and it is cleared by a restart. A gate a person engaged also lapses by itself — see adminHold. A run engages the same gate, and a run starting over a person's hold takes it: a scheduled service outranks an ad-hoc lock, and the hold stops counting from that moment rather than expiring later under music that is playing. Releasing it, or a run taking it, ends a level measurement, which puts the deck and the desk back on its way out.
    adminHold: Deadline  # When a gate a person engaged lapses by itself. It waits for music that has an end — a track that will finish, or one told when to stop — because releasing under a song that is still sounding opens the panel mid-music. Never more than an hour ahead: a panel locked and forgotten is a panel nobody in the building can use, and the person who locked it has usually gone home. Lapsing does what releasing does — the user's song comes back with it. extendAdminHold pushes it out while somebody is still there. Reads none when the gate is open, and while a flow holds it: a run names its own window and ends on its own.
    audioLock: bool  # True while the audio device is mid-transition. Read-only, and it refuses everyone including admins: it guards the device, not permissions.
    isAdmin: bool  # Whether this connection holds admin rights. Per-connection, so it is only ever sent to the client it describes.
    flow: FlowStatus  # What the server's one flow slot is doing. Always readable: an idle slot says so rather than reading as nothing. Read-only — startFlow and stopFlow change it.
    schedule: list[ScheduleEntry]  # The weekly calendar this server keeps: every flow that may be run, in the order they were written. State rather than a one-shot list, because it is edited while clients are connected. Read-only — saveFlow and deleteFlow move it. It lives here because it is persistent, and because whether a track may be deleted depends on whether a flow still names it, which only whoever holds both can answer.
    clockOffsetSec: float  # How far ahead of standard time the church clock runs, in seconds, kept to the millisecond — a correction set by pressing a key on the wall clock's flip is rarely a whole second. Negative means behind. Every instant on this wire is read against it, so writing it moves the whole schedule. Refused with adminLocked while the gate is held: a flow holds the gate for its whole run, which makes it impossible to move the clock out from under music that is already playing. Survives restarts.
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
    read. Refused with consoleHeld while the server has set part of the desk
    aside and this input is in it: the server puts it back itself when it is
    done, and the input can be switched on again then.
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
    to have changed by the time the call returns. Refused with consoleHeld,
    before anything is sent, while the server has set aside any part of the
    desk it would write.
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
    id: str  # Track id from the tracks attribute
    volume: float  # 0-100


class AddTrackArgs(TypedDict):
    """
    Make a new track, stored on the server for good: its audio moves into the
    library's folder and the track is written to the manifest, so it survives
    a restart. It arrives on every client as a tracks patch, at the level
    every new track starts at (50), and the panel does not offer it — a
    library track needs the gate. Surrounding spaces are trimmed from the
    title, and a title left empty is refused with invalidValue before the
    audio is touched, so the same upload can be tried again with a name.
    Titles are unique: one another track already has, or that a fetch in
    flight is about to take, is refused with titleTaken — also before the
    audio is touched. Refused with unknownUpload for an upload that was never
    made, has already become a track, or was not claimed in time. From YouTube
    the server fetches the audio itself, one video at a time: trackFetch says
    so to every client while it runs, and the command answers when it ends.
    Refused with invalidValue for an address that is not YouTube's, fetchBusy
    while another fetch runs, tooLarge past 300MB, and fetchFailed for a video
    that cannot be had — gone, private, blocked, or not done within ten
    minutes.
    """
    title: str  # What to call it. Always given — never taken from the file.
    source: TrackSource  # Where the audio comes from


class RenameTrackArgs(TypedDict):
    """
    Change what a track is called. Its id and audio stay as they are, so every
    flow that names it still does. Surrounding spaces are trimmed, and a title
    left empty is refused with invalidValue, one another track already has
    with titleTaken. Refused with deckSong for a song the panel offers: those
    are named once, in ready.songs, and a panel installed by hand is not asked
    to notice a rename.
    """
    id: str  # Track id from the tracks attribute
    title: str  # The new name


class DeleteTrackArgs(TypedDict):
    """
    Take a track out of the library and delete its audio file. Refused with
    deckSong for a song the panel offers, and with trackInUse while anything
    still needs it: a calendar entry that names it, the run in flight, or the
    deck it is on right now. A run copies its tracks when it starts, so the
    calendar alone would let a run lose a track it has yet to play.
    """
    id: str  # Track id from the tracks attribute


class SelectTrackArgs(TypedDict):
    """
    Put a library track on the deck, paused at its start, at its own level —
    the same act as writing the song attribute, for the tracks that are not
    among ready.songs. Playing it is a separate write to playback. Refused
    with adminUnlocked unless the gate is held: while the panel is open it
    shows the song it thinks is playing, and a track it never chose would make
    that a lie. Refused with flowActive while a run's music is sounding — a
    run holds the gate, so that first check passes during a service and this
    one is what keeps the deck the run's. While a run only holds the gate this
    is allowed, and what it puts on is faded out when the run's own music
    comes due; the run goes back to the deck it was handed, not to the track
    somebody put on during its quiet half. Releasing the gate takes the track
    off and puts the user's song back. Refused with levelMatching while a
    level measurement has the deck.
    """
    id: str  # Track id from the tracks attribute


class MatchTrackLevelArgs(TypedDict):
    """
    Measure a track on the desk and move its level so the desk's meter
    averages the target. The music player's input is switched off on the desk
    and read back before anything plays, so the room hears nothing; the track
    then plays from its start at its own level while the input's meter is
    read, and the deck and the desk are put back after it has stopped —
    however it ends. The average leaves out silence and the passages well
    under the song's own level, so a quiet verse does not drag it down. The
    new level is the one written down for the track, as setTrackVolume would
    write it; a flow already saved keeps the levels it was written with.
    Answers as soon as it is accepted; how it goes is in levelMatch. Only for
    a person holding the gate with nothing playing: refused with adminUnlocked
    when the gate is open, flowActive when the gate is a run's, deckPlaying
    while the deck plays, deckMuted while output is muted (it would measure
    silence), levelMatching while another measurement runs, unknownTrack, and
    invalidValue for a target outside -60 to 0 or a span that is not one.
    While it runs the deck is the measurement's — song, playback, volume,
    mute, loop and selectTrack are refused with levelMatching — and the music
    player's input is held on the desk, so switching it on is refused with
    consoleHeld. Releasing the gate, a run taking it, or a hand switching the
    input on at the desk ends it. A level change applies from the next time
    the track is chosen.
    """
    track: str  # Track id from the tracks attribute
    targetDb: float  # The average the desk's meter should read for this track, in dB under full scale, -60 to 0. Always given: there is no level the server would assume.
    span: LevelSpan  # How much of the track to play


class StopLevelMatchArgs(TypedDict):
    """
    End the level measurement now: the track stops, the deck and the desk are
    put back, and no level changes. levelMatch reads failed, why stopped.
    Refused with notMeasuring when none is running.
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
    "loop": {"access": "rw", "permission": "admin"},
    "tracks": {"access": "ro"},
    "trackFetch": {"access": "ro"},
    "levelMatch": {"access": "ro"},
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
    "addTrack": {"permission": "admin"},
    "renameTrack": {"permission": "admin"},
    "deleteTrack": {"permission": "admin"},
    "selectTrack": {"permission": "admin"},
    "matchTrackLevel": {"permission": "admin"},
    "stopLevelMatch": {"permission": "admin"},
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
    Answer to hello: what this server speaks and what it supports. When
    accepted is false the client is on an incompatible protocol version — it
    should tell the user to update. State still arrives, but writes and
    invokes are refused with protocolMismatch.
    """
    protocolVersion: float  # Version this server speaks
    accepted: bool
    attributes: list[str]  # Attributes this server implements. Hide controls for anything absent.
    commands: list[str]  # Commands this server implements. Hide controls for anything absent.
    songs: list[Song]  # Songs a user may select, with the names to show, in the order to show them. How many there are is the server's to say, so a client draws one control per entry rather than assuming a count — adding a song is then a server change alone. Fixed at boot.
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
