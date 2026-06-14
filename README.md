# church-media-server

A Socket.IO server that lets several phones/tablets remotely control the
background worship music and the mixing console during a church service. It
plays audio through **libmpv** and drives a **Behringer X32** console over OSC.
Typically runs on a Raspberry Pi in the A/V booth; developed on macOS.

It manages two background songs (slow / fast) with smooth fades, per-song
volumes and position memory, volume/mute, and the pastor mic / aux on the X32 —
all kept in sync across every connected client.

> For architecture, the locking model, the socket protocol, and internals, see
> [DEVELOPMENT.md](DEVELOPMENT.md).

## Requirements

- **Node.js 22+** (developed on 24)
- **libmpv** on the host
  - macOS: `brew install mpv`
  - Debian / Raspberry Pi OS: `sudo apt install libmpv2` (or `libmpv-dev`)
- **Audio files** at `assets/audio/music_slow.mp3` and `assets/audio/music_fast.mp3`
- A reachable **X32 console** when `CONSOLE_MODE=X32` (use `MOCK` otherwise)

## Run

```bash
npm install
cp .env.example .env      # then edit (see Environment)
# put your two mp3s in assets/audio/
npm start                 # builds, then runs dist/main.js
```

Stop with `Ctrl-C` / `SIGTERM` (graceful shutdown).

## Environment

All variables are **required** — the server fails fast at startup naming any
missing or invalid one (no silent defaults). Copy `.env.example` and adjust.

| Variable | Meaning | Example |
|---|---|---|
| `PORT` | Socket.IO port | `4000` |
| `CONSOLE_MODE` | `X32` (real console) or `MOCK` (logs only) | `X32` |
| `ADMIN_PASSWORD` | Admin auth password | `change-me` |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` | `info` |
| `X32_REMOTE_ADDRESS` | X32 console IP | `192.168.0.3` |
| `X32_REMOTE_PORT` | X32 OSC port | `10023` |
| `MPV_LIBRARY_PATH` | libmpv shared library path | `/opt/homebrew/lib/libmpv.dylib` (macOS) · `/lib/arm-linux-gnueabihf/libmpv.so` (Pi) |

## Commands

| Command | Does |
|---|---|
| `npm start` | Build, then run `dist/main.js` |
| `npm run build` | Clean `dist/` and compile |
| `npm run build:watch` | `tsc --watch` |
| `npm run typecheck` | Type-check only (no emit) |
| `npm test` | Build, then run the test suite from `dist/` |
| `npm run test:watch` | Re-run tests from `dist/` on change |

## Production (PM2)

On the Pi, PM2 runs the built server and restarts it on crash or reboot:

```bash
npm ci
npm run build
pm2 start ecosystem.config.cjs
pm2 save       # remember the running process
pm2 startup    # run the printed command once → auto-start on boot
```

`pm2 stop` / `pm2 restart` trigger a graceful shutdown;
`pm2 logs church-media-server` tails output.

## Notes

- **Preferences persist across restarts and reboots** (volume, mute, song — in
  `STATE_FILE_PATH`), but the server **always boots paused**: a reboot never
  auto-starts audio.
- **Audio files are gitignored** — provide your own `music_slow.mp3` /
  `music_fast.mp3` under `assets/audio/`.
- **`libmpv` must match the Node process architecture** (e.g. arm libmpv for
  the Pi); `MPV_LIBRARY_PATH` points at it.
- Use **`CONSOLE_MODE=MOCK`** to develop without an X32 (mixer actions are just
  logged).
- `ADMIN_PASSWORD` is a **single shared placeholder password** — replace it
  with a real auth system before any untrusted deployment.
- Clients connect on the **default Socket.IO path `/`** (not `/api/socket`).
