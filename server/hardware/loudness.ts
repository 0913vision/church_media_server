import { x32Db, x32Fader } from '../console/faderLevel.ts';

/**
 * The music player's volume as people hear it.
 *
 * The 0–100 every screen shows is read on the X32 fader's shape, the curve the
 * people running the room already have in their hands: 100 is the file's own
 * level (0 dB, the fader's unity mark), 50 is −20 dB, 10 is −58 dB, and the
 * bottom runs down to −80 dB, which counts as silence. Nothing goes above 0 dB:
 * the tracks are mastered to within a tenth of a decibel of full scale, so any
 * gain here would clip, and the desk is where the room is turned up.
 *
 * mpv's own volume is cubic — the gain is (v/100)³, measured: halving it took
 * 18.1 dB off — so a level becomes decibels on the fader's curve and decibels
 * become mpv's volume through the cube.
 */

/** Silence, for the purposes of a level and of a fade: nobody in a room hears below it. */
export const FLOOR_DB = -80;
/** Where the X32 fader stands at 0 dB — 100 on this scale. */
const UNITY_FADER = 0.75;
/** The X32 curve's bottom segment starts here; below, the scale runs straight to FLOOR_DB. */
const BOTTOM_DB = -60;
const BOTTOM_FADER = x32Fader(BOTTOM_DB);

/** Decibels for a level, 0 dB at 100; −Infinity at 0. Above 100 follows the fader past unity. */
export function dbFromLevel(level: number): number {
  if (!(level > 0)) return -Infinity;
  const fader = (level / 100) * UNITY_FADER;
  if (fader >= BOTTOM_FADER) return x32Db(fader);
  return FLOOR_DB + (BOTTOM_DB - FLOOR_DB) * (fader / BOTTOM_FADER);
}

/**
 * The level for some decibels — dbFromLevel read backwards. FLOOR_DB and below is
 * 0; above 0 dB it runs on past 100 along the fader (up to +10 dB, 133⅓), so a
 * level that cannot be reached still says how far off it is.
 */
export function levelFromDb(db: number): number {
  if (db <= FLOOR_DB) return 0;
  const fader = db >= BOTTOM_DB ? x32Fader(db) : BOTTOM_FADER * ((db - FLOOR_DB) / (BOTTOM_DB - FLOOR_DB));
  return (fader / UNITY_FADER) * 100;
}

/** mpv's volume for some decibels under the file's own level. */
export function mpvVolumeFromDb(db: number): number {
  return db === -Infinity ? 0 : 100 * 10 ** (db / 60);
}

/** What a level meant before the scale took the fader's shape: mpv's cube, straight. */
export function dbFromCubicLevel(level: number): number {
  return level > 0 ? 60 * Math.log10(level / 100) : -Infinity;
}

/** Where a fade in is quiet enough to be all but unheard, and from where it rises at an even pace. */
const AUDIBLE_DB = -40;
/** The rise from silence to AUDIBLE_DB: a tenth of the fade, and never more than this. */
const QUICK_MAX_MS = 300;
const QUICK_SHARE = 0.1;

/**
 * Where a fade in stands `t` ms into one lasting `durationMs`, in decibels under
 * the level it rises to. Any length.
 *
 * Note(yoochan.kim): the way a hand pushes a fader up: through the bottom, where nothing
 * is heard, quickly, then at an even pace — the same decibels every second, which
 * the ear hears as an even rise. From silence at that pace the first half of the
 * fade went unheard (−80 to −40 dB), and a press of play seemed not to land.
 */
export function fadeInDb(t: number, durationMs: number): number {
  if (t <= 0) return FLOOR_DB;
  if (t >= durationMs) return 0;
  const quick = Math.min(QUICK_MAX_MS, durationMs * QUICK_SHARE);
  if (t < quick) return FLOOR_DB + (AUDIBLE_DB - FLOOR_DB) * (t / quick);
  return AUDIBLE_DB * (1 - (t - quick) / (durationMs - quick));
}

/** A fade out is a fade in run backwards: an even fall to −40 dB, then quickly away. */
export function fadeOutDb(t: number, durationMs: number): number {
  return fadeInDb(durationMs - t, durationMs);
}
