/** The X32 fader's 0..1 curve is piecewise, so configuration says decibels and this says what to send. */

/** The desk's own range: below this is off, above it is the top of the fader. */
const MIN_DB = -90;
const MAX_DB = 10;

export function faderFromDb(db: number): number {
  // Note(yoochan.kim): rounded as the desk reports levels back, so a value sent and one read compare equal.
  return Math.round(x32Fader(db) * 10000) / 10000;
}

/** How many values the desk knows between 0 and 1 (unofficial X32 OSC protocol v4.09). */
export const FADER_STEPS = 1024;
export const SEND_STEPS = 161;

/** The fader's curve snapped to a send's steps: off a step, the desk rounds it and it never reads back as landed. */
export function sendLevelFromDb(db: number): number {
  return Math.round(x32Fader(db) * (SEND_STEPS - 1)) / (SEND_STEPS - 1);
}

/** The same curve read backwards, for saying what a level the desk reported means. */
export function dbFromFader(level: number): number {
  return Math.round(x32Db(level) * 10) / 10;
}

/** The curve itself, unrounded — for the music player's own scale, which takes its shape. */
export function x32Fader(db: number): number {
  const clamped = Math.min(MAX_DB, Math.max(MIN_DB, db));
  return clamped >= -10 ? (clamped + 30) / 40 :
    clamped >= -30 ? (clamped + 50) / 80 :
    clamped >= -60 ? (clamped + 70) / 160 :
    (clamped + 90) / 480;
}

export function x32Db(level: number): number {
  const clamped = Math.min(1, Math.max(0, level));
  return clamped >= 0.5 ? clamped * 40 - 30 :
    clamped >= 0.25 ? clamped * 80 - 50 :
    clamped >= 0.0625 ? clamped * 160 - 70 :
    clamped * 480 - 90;
}
