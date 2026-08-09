/**
 * Decibels as the X32 wants them.
 *
 * Every fader on the desk takes a number from 0 to 1, and the curve from that
 * number to decibels is piecewise — four straight segments, steeper at the
 * bottom where nobody needs the resolution. A level written as `-9 dB` in a
 * config is therefore not something that can be sent as it stands, and a level
 * written as `0.525` is not something anyone can check against the desk.
 *
 * So configuration says decibels and this says what to send.
 */

/** The desk's own range: below this is off, above it is the top of the fader. */
const MIN_DB = -90;
const MAX_DB = 10;

/**
 * The X32 fader curve, as four segments.
 *
 *   0.5 … 1.0   ->  -10 … +10 dB
 *   0.25 … 0.5  ->  -30 … -10 dB
 *   0.0625…0.25 ->  -60 … -30 dB
 *   0 … 0.0625  ->  -90 … -60 dB
 */
export function faderFromDb(db: number): number {
  const clamped = Math.min(MAX_DB, Math.max(MIN_DB, db));
  const level =
    clamped >= -10 ? (clamped + 30) / 40 :
    clamped >= -30 ? (clamped + 50) / 80 :
    clamped >= -60 ? (clamped + 70) / 160 :
    (clamped + 90) / 480;
  // Note(yoochan.kim): rounded the way the desk reports levels back, so a value
  // sent and a value read compare equal instead of differing in the sixth place.
  return Math.round(level * 10000) / 10000;
}

/** The same curve read backwards, for saying what a level the desk reported means. */
export function dbFromFader(level: number): number {
  const clamped = Math.min(1, Math.max(0, level));
  const db =
    clamped >= 0.5 ? clamped * 40 - 30 :
    clamped >= 0.25 ? clamped * 80 - 50 :
    clamped >= 0.0625 ? clamped * 160 - 70 :
    clamped * 480 - 90;
  return Math.round(db * 10) / 10;
}
