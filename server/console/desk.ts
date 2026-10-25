import { faderFromDb, sendLevelFromDb, FADER_STEPS, SEND_STEPS } from './faderLevel.ts';

/**
 * The words for saying what to do to the desk: strips, values, and changes made
 * of them. Pure — nothing here talks to a desk — so a change is a value that can
 * be built, mapped over a list of strips, compared and written down.
 *
 * Addresses, counts and steps are the unofficial X32 OSC protocol's (v4.09).
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
const FADER_STEP = 1 / (FADER_STEPS - 1);

/** Whether the desk holds what was asked for: switches exactly, levels to the step. */
export function sameValue(a: DeskValue, b: DeskValue): boolean {
  if (a.type === 'i' && b.type === 'i') return a.value === b.value;
  return Math.abs(a.value - b.value) <= FADER_STEP;
}

/** A mix bus or a matrix: somewhere a send goes. */
export type Bus = `/bus/${string}`;
export type Mtx = `/mtx/${string}`;

/** A strip, by its OSC path. A string, so two spellings of one strip compare equal. */
export type Strip =
  | `/ch/${string}` | `/auxin/${string}` | `/fxrtn/${string}` | Bus | Mtx
  | '/main/st' | '/main/m' | `/dca/${string}`;

export type MuteGroup = `/config/mute/${string}`;

const numbered = <P extends string>(prefix: P, count: number, width: number) =>
  (n: number): `${P}/${string}` => {
    if (!Number.isInteger(n) || n < 1 || n > count) throw new RangeError(`${prefix} ${n} is not on this desk`);
    return `${prefix}/${String(n).padStart(width, '0')}`;
  };

/** Input channel 1–32 */
export const ch = numbered('/ch', 32, 2);
/** Aux input 1–8 */
export const auxin = numbered('/auxin', 8, 2);
/** FX return 1–8 */
export const fxrtn = numbered('/fxrtn', 8, 2);
/** Mix bus 1–16 */
export const bus = numbered('/bus', 16, 2);
/** Matrix 1–6 */
export const mtx = numbered('/mtx', 6, 2);
/** The stereo and mono masters */
export const mainSt = '/main/st';
export const mainMono = '/main/m';
/** DCA 1–8. The desk numbers these without a leading zero. */
export const dca = numbered('/dca', 8, 1);
/** Mute group 1–6 */
export const muteGroup = numbered('/config/mute', 6, 1);

/** One address set to one value — the unit a hold remembers and puts back. */
export interface DeskChange {
  readonly address: string;
  readonly value: DeskValue;
}

/** Where a strip's switch and fader live: under /mix, except on a DCA. */
const controls = (strip: Strip): string => (strip.startsWith('/dca/') ? strip : `${strip}/mix`);

export const on = (strip: Strip): DeskChange => ({ address: `${controls(strip)}/on`, value: int(1) });
export const off = (strip: Strip): DeskChange => ({ address: `${controls(strip)}/on`, value: int(0) });
/** A strip's fader at a level in decibels; the curve is faderLevel's. */
export const fader = (strip: Strip, db: number): DeskChange =>
  ({ address: `${controls(strip)}/fader`, value: float(faderFromDb(db)) });

/**
 * Whether a strip sends to that bus or matrix: channels, aux inputs and FX
 * returns feed the mix buses; buses and the two masters feed the matrices.
 * Matrices and DCAs send nowhere.
 */
function routes(from: Strip, to: Bus | Mtx): boolean {
  if (/^\/(ch|auxin|fxrtn)\//.test(from)) return to.startsWith('/bus/');
  if (/^\/(bus\/|main\/)/.test(from)) return to.startsWith('/mtx/');
  return false;
}

/** The part of a strip that feeds one bus or matrix, numbered like the bus or matrix it feeds. */
function sendPath(from: Strip, to: Bus | Mtx): string {
  if (!routes(from, to)) throw new RangeError(`${from} has no send to ${to}`);
  return `${from}/mix/${to.slice(to.lastIndexOf('/') + 1)}`;
}

export const sendOn = (from: Strip, to: Bus | Mtx): DeskChange => ({ address: `${sendPath(from, to)}/on`, value: int(1) });
export const sendOff = (from: Strip, to: Bus | Mtx): DeskChange => ({ address: `${sendPath(from, to)}/on`, value: int(0) });
/** A send at a level in decibels, on the steps a send has. */
export const sendLevel = (from: Strip, to: Bus | Mtx, db: number): DeskChange =>
  ({ address: `${sendPath(from, to)}/level`, value: float(sendLevelFromDb(db)) });

/** A mute group engaged mutes every strip assigned to it; released, it lets them be. */
export const engage = (group: MuteGroup): DeskChange => ({ address: group, value: int(1) });
export const release = (group: MuteGroup): DeskChange => ({ address: group, value: int(0) });

/** What one address on the desk holds: a switch, or a level and how many steps it has. */
export type DeskAddress = { readonly kind: 'switch' } | { readonly kind: 'level'; readonly steps: number };

const SWITCH: DeskAddress = { kind: 'switch' };
const FADER: DeskAddress = { kind: 'level', steps: FADER_STEPS };
const SEND: DeskAddress = { kind: 'level', steps: SEND_STEPS };

const upTo = <T>(count: number, make: (n: number) => T): T[] => Array.from({ length: count }, (_, i) => make(i + 1));

/**
 * Every address the words above can build, and what each holds — built by those
 * same words, so the two can never disagree about what the desk has.
 */
const ADDRESSES: ReadonlyMap<string, DeskAddress> = (() => {
  const strips: Strip[] = [
    ...upTo(32, ch), ...upTo(8, auxin), ...upTo(8, fxrtn), ...upTo(16, bus), ...upTo(6, mtx),
    mainSt, mainMono, ...upTo(8, dca),
  ];
  const destinations = [...upTo(16, bus), ...upTo(6, mtx)];
  const all = new Map<string, DeskAddress>();
  for (const strip of strips) {
    all.set(on(strip).address, SWITCH);
    all.set(fader(strip, 0).address, FADER);
    for (const to of destinations.filter((destination) => routes(strip, destination))) {
      all.set(sendOn(strip, to).address, SWITCH);
      all.set(sendLevel(strip, to, 0).address, SEND);
    }
  }
  for (const group of upTo(6, muteGroup)) all.set(group, SWITCH);
  return all;
})();

/**
 * What an address holds, or null when the desk has no such address — a typo, a
 * strip past the desk's count, a send the desk does not route. For something
 * standing in for the desk.
 */
export function deskAddress(address: string): DeskAddress | null {
  return ADDRESSES.get(address) ?? null;
}
