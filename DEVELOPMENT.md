# Development

Architecture and internals for `church-media-server`. For setup and running,
see [README.md](README.md). `CLAUDE.md` holds guidance specific to AI assistants.

## Architecture

Layered, with all wiring done once in the composition root (`server/server.ts`),
the only place that touches `io`:

```
server.ts  (composition root — builds the object graph by constructor injection)
  ├─ handlers/*            transport adapters: parse event → validate → call service → notify
  ├─ notify/Notifier       single owner of all server→client emission
  ├─ lock/LockCoordinator   audio lock + admin lock (over the generic lock/Lock)
  ├─ player/Player          audio domain state, over the AudioOutput interface:
  │                            hardware/AudioDevice ── hardware/MpvClient (libmpv FFI)
  ├─ console/MixerConsole   mixer service over the ConsoleDevice interface:
  │                            console/X32Console (OSC) | console/MockConsole
  ├─ state/FileStateStore   persists player preferences (StateStore interface)
  └─ auth/AdminSessionManager
```

Responsibilities are kept narrow: handlers know transport + validation but no
domain rules; the Notifier owns every event name and the broadcast-vs-reply
choice; the lock layer knows nothing about sockets (callers pass `isAdmin`
booleans / opaque holder ids); `Player` depends on the `AudioOutput` interface,
not the concrete device, so it can be unit-tested with a fake.

## Locking

Two independent, orthogonal locks, each broadcast on its own event:

- **Audio lock** (`lockChanged`) — a resource critical section held only while
  the audio device is mid-transition (play / pause / song change). It protects
  the non-atomic fade; a contending audio request is rejected. The console
  takes no resource lock.
- **Admin lock** (`adminLockChanged`) — a global gate an authenticated admin
  toggles (`setAdminLock`). While held, no other user may *start* a new
  operation; in-flight operations finish independently. Auto-released when the
  holding admin disconnects.

The admin lock gates *who may start an operation*; the audio lock gates
*concurrent mutation of the audio resource*. They never wait on each other.

## Socket protocol

Default Socket.IO path `/`. The same `xChanged` event answers a `getX` (to the
requester) and announces a change (broadcast to everyone).

**Client → server**

| Event | Payload | Notes |
|---|---|---|
| `getVolume` `getState` `getMute` `getCurrentSong` `getLock` | — | reply with current value(s) |
| `changeVolume` | number 0–100 | validated; invalid → no broadcast |
| `changeState` | `0` paused \| `1` playing | validated |
| `changeMute` | `0` \| `1` | validated |
| `changeSong` | `(clientCurrentSong, newSong)` | server state is authoritative; `clientCurrentSong` ignored |
| `micOn` `auxOn` | — | console, admin-gated only |
| `authenticateAdmin` | password | replies `adminAuthenticated {success}` |
| `setAdminLock` | boolean | authenticated admins only |

**Server → client**: `volumeChanged` `stateChanged` `muteChanged` `songChanged`
`lockChanged` `adminLockChanged` `adminAuthenticated` `ping`

The protocol is typed: `ServerToClientEvents` / `ClientToServerEvents` in
`server/constants/socketConfig.ts` parameterize the Socket.IO server, so every
emit is compile-checked. C2S payloads are `unknown` by design (untrusted) and
narrowed by the runtime guards in `server/constants/playerStates.ts`.

## Domain behavior

- Two songs, `slow` and `fast`, with per-song default volumes (50 / 35).
- Play/pause use an equal-power fade (`FADE_STEPS` × `FADE_STEP_MS` in
  `deviceConfig`); the audio lock is held for the whole fade.
- Switching songs remembers the previous song's playback position.
- While muted, volume and song changes keep the device silent and only update
  the remembered level.

## State persistence

Player preferences (volume, mute, song — **not** play/pause) are persisted to
`STATE_FILE_PATH` via the `StateStore` interface (`FileStateStore` writes a
small JSON document atomically: temp file + rename). The composition root loads
them at boot, merges them over the defaults, and **forces `PAUSED`** — so a
`pm2 restart` / reboot restores the operator's settings but never auto-starts
audio. `Player` calls the injected persist callback on every preference change.
The mpv instance is in-process (FFI), so a process death leaves no orphan audio.

## Testing

`tests/ut/*.test.ts`. `npm test` is self-contained: each test file starts an
in-process **MOCK** console server on `PORT` when nothing is listening (real
mpv stays paused, so it is silent) and stops it afterward; an externally running
dev server is used as-is. Files run serially (`--test-concurrency=1`) for
determinism against the shared server, so tests assert value *types* or read
current state rather than assuming globals.

- `player.unit.test.ts` — pure unit test (no server); injects a fake
  `AudioOutput` to assert muted behavior.
- `socket-getters` / `socket-changes` / `admin-lock` / `audio-lock` /
  `legacy-deprecated` — socket-level integration tests pinning the protocol
  contract, lock propagation, admin gating, and `/api/socket` rejection.

## Toolchain

- **Strict TypeScript** (plus `noUncheckedIndexedAccess`, `noUnusedLocals`/
  `Parameters`, `verbatimModuleSyntax`, `sourceMap`), compiled with `tsc` to
  `dist/` (NodeNext ESM). Source imports use `.ts` extensions, rewritten to
  `.js` in the emitted output.
- Required-env access goes through `server/utils/env.ts`
  (`requireEnv` / `requireIntEnv` / `requireEnvOneOf`) — fail-fast, no defaults.
- Untyped deps (`osc`, `ffi-napi`, `ref-array-napi`) have minimal local shims in
  `types/shims.d.ts`.

## Known limitations / backlog

- Admin auth is a single shared password, stored as a salted scrypt hash
  (`server/auth/password.ts`); a per-user admin page is planned.
- Blocked/invalid requests are logged but the requester gets no ack/error event.
- CORS is open (`origin: "*"`).
