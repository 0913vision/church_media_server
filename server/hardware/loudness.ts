import { x32Db, x32Fader } from '../console/faderLevel.ts';

/** 0–100 is read on the X32 fader's shape, the curve the people running the room already have in their hands. */

/** Silence, for the purposes of a level and of a fade: nobody in a room hears below it. */
export const FLOOR_DB = -80;
/** 0 dB is 100 and the top: the tracks peak within 0.1 dB of full scale, so gain would clip; the desk turns it up. */
const UNITY_FADER = 0.75;
/** The X32 curve's bottom segment starts here; below, the scale runs straight to FLOOR_DB. */
const BOTTOM_DB = -60;
const BOTTOM_FADER = x32Fader(BOTTOM_DB);

export function dbFromLevel(level: number): number {
  if (!(level > 0)) return -Infinity;
  const fader = (level / 100) * UNITY_FADER;
  if (fader >= BOTTOM_FADER) return x32Db(fader);
  return FLOOR_DB + (BOTTOM_DB - FLOOR_DB) * (fader / BOTTOM_FADER);
}

/** Runs on past 100 along the fader, so a level that cannot be reached still says how far off it is. */
export function levelFromDb(db: number): number {
  if (db <= FLOOR_DB) return 0;
  const fader = db >= BOTTOM_DB ? x32Fader(db) : BOTTOM_FADER * ((db - FLOOR_DB) / (BOTTOM_DB - FLOOR_DB));
  return (fader / UNITY_FADER) * 100;
}

/** mpv's volume is cubic, measured: halving it took 18.1 dB off. */
export function mpvVolumeFromDb(db: number): number {
  return db === -Infinity ? 0 : 100 * 10 ** (db / 60);
}

/** A level stored on mpv's cubic volume, which rescale-volumes moves onto this scale. */
export function dbFromCubicLevel(level: number): number {
  return level > 0 ? 60 * Math.log10(level / 100) : -Infinity;
}

/** The rise from silence to where a fade starts: a tenth of the fade, and never more than this. */
const QUICK_MAX_MS = 300;
const QUICK_SHARE = 0.1;

/** Decibels under the level a fade in rises to, moved the way a hand pushes a fader up. */
export function fadeInDb(t: number, durationMs: number, startDb: number): number {
  if (t <= 0) return FLOOR_DB;
  if (t >= durationMs) return 0;
  const quick = Math.min(QUICK_MAX_MS, durationMs * QUICK_SHARE);
  // Note(yoochan.kim): through the unheard bottom quickly, or a press of play seems not to land.
  if (t < quick) return FLOOR_DB + (startDb - FLOOR_DB) * (t / quick);
  // Note(yoochan.kim): then the same dB every moment, which the ear hears as an even rise.
  return startDb * (1 - (t - quick) / (durationMs - quick));
}

export function fadeOutDb(t: number, durationMs: number, startDb: number): number {
  return fadeInDb(durationMs - t, durationMs, startDb);
}
