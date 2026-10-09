import { faderFromDb } from './faderLevel.ts';

/**
 * The words for saying what to do to the desk: strips, values, and changes made
 * of them. Pure — nothing here talks to a desk — so a change is a value that can
 * be built, mapped over a list of strips, compared and written down.
 */

/**
 * One value on the desk's wire, typed the way the desk types it: switches are
 * ints, levels are floats. Kept with its type so that putting a value back sends
 * exactly what the desk reported.
 */
export interface DeskValue {
  readonly type: 'i' | 'f';
  readonly value: number;
}

export const int = (value: number): DeskValue => ({ type: 'i', value });
export const float = (value: number): DeskValue => ({ type: 'f', value });

/** A fader has 1024 positions, so a level reads back as the nearest one. */
const FADER_STEP = 1 / 1023;

/** Whether the desk holds what was asked for: switches exactly, levels to the step. */
export function sameValue(a: DeskValue, b: DeskValue): boolean {
  if (a.type === 'i' && b.type === 'i') return a.value === b.value;
  return Math.abs(a.value - b.value) <= FADER_STEP;
}

/** A channel strip, by its OSC path. A string, so two spellings of one strip compare equal. */
export type Strip = `/ch/${string}` | `/auxin/${string}`;

const strips = <P extends string>(prefix: P, count: number) =>
  (n: number): `${P}/${string}` => {
    if (!Number.isInteger(n) || n < 1 || n > count) throw new RangeError(`${prefix} ${n} is not on this desk`);
    return `${prefix}/${String(n).padStart(2, '0')}`;
  };

/** Input channel 1–32 */
export const ch = strips('/ch', 32);
/** Aux input 1–8 */
export const auxin = strips('/auxin', 8);

/** One address set to one value — the unit a hold remembers and puts back. */
export interface DeskChange {
  readonly address: string;
  readonly value: DeskValue;
}

export const on = (strip: Strip): DeskChange => ({ address: `${strip}/mix/on`, value: int(1) });
export const off = (strip: Strip): DeskChange => ({ address: `${strip}/mix/on`, value: int(0) });
/** A strip's fader at a level in decibels; the curve is faderLevel's. */
export const fader = (strip: Strip, db: number): DeskChange =>
  ({ address: `${strip}/mix/fader`, value: float(faderFromDb(db)) });
