// Domain state enums shared over the protocol (values mirror the client)

/** Playback state (protocol value: 0 | 1) */
export enum PlayerState {
  PAUSED = 0,
  PLAYING = 1
}

/** Mute state (protocol value: 0 | 1) */
export enum MuteState {
  UNMUTED = 0,
  MUTED = 1
}

/** Song selection (protocol value: 'slow' | 'fast') */
export enum SongType {
  SLOW = 'slow',
  FAST = 'fast'
}

// Runtime guards for untrusted client payloads
export function isPlayerState(value: unknown): value is PlayerState {
  return value === PlayerState.PAUSED || value === PlayerState.PLAYING;
}

export function isMuteState(value: unknown): value is MuteState {
  return value === MuteState.UNMUTED || value === MuteState.MUTED;
}

export function isSongType(value: unknown): value is SongType {
  return value === SongType.SLOW || value === SongType.FAST;
}
