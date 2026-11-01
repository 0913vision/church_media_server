import { faderFromDb, sendLevelFromDb, FADER_STEPS, SEND_STEPS } from './faderLevel.ts';

/** Desk changes as pure values, to be mapped, compared and journalled; per the unofficial X32 OSC protocol v4.09. */

/** Kept with its OSC type (switch int, level float) so putting a value back sends exactly what the desk reported. */
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

export const ch = numbered('/ch', 32, 2);
export const auxin = numbered('/auxin', 8, 2);
export const fxrtn = numbered('/fxrtn', 8, 2);
export const bus = numbered('/bus', 16, 2);
export const mtx = numbered('/mtx', 6, 2);
export const mainSt = '/main/st';
export const mainMono = '/main/m';
/** The desk numbers DCAs without a leading zero. */
export const dca = numbered('/dca', 8, 1);
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

/** Strips with a main send and group assignments: inputs, aux ins, FX returns and buses. */
const MIXED = /^\/(ch|auxin|fxrtn|bus)\//;

function mixed(strip: Strip): Strip {
  if (!MIXED.test(strip)) throw new RangeError(`${strip} has no main send or groups`);
  return strip;
}

/** A strip's send to the main stereo bus (LR). */
export const mainSend = (strip: Strip, on: boolean): DeskChange =>
  ({ address: `${mixed(strip)}/mix/st`, value: int(on ? 1 : 0) });
/** A strip's send to the mono bus. */
export const monoSend = (strip: Strip, on: boolean): DeskChange =>
  ({ address: `${mixed(strip)}/mix/mono`, value: int(on ? 1 : 0) });

/** A bitmap of group numbers, group 1 in the lowest bit, as the desk keeps them. */
function members(groups: readonly number[], count: number): number {
  let bits = 0;
  for (const group of groups) {
    if (!Number.isInteger(group) || group < 1 || group > count) throw new RangeError(`group ${group} is not on this desk`);
    bits |= 1 << (group - 1);
  }
  return bits;
}

/** The mute groups (1–6) a strip is in, written whole so a put-back restores each; none takes it out of every one. */
export const muteGroupsOf = (strip: Strip, groups: readonly number[]): DeskChange =>
  ({ address: `${mixed(strip)}/grp/mute`, value: int(members(groups, 6)) });
/** The DCAs (1–8) a strip is in, all at once; none takes it out of every one. */
export const dcasOf = (strip: Strip, dcas: readonly number[]): DeskChange =>
  ({ address: `${mixed(strip)}/grp/dca`, value: int(members(dcas, 8)) });

/** A mute group engaged mutes every strip assigned to it; released, it lets them be. */
export const engage = (group: MuteGroup): DeskChange => ({ address: group, value: int(1) });
export const release = (group: MuteGroup): DeskChange => ({ address: group, value: int(0) });

/** What one address on the desk holds: a switch, a level and how many steps it has, or a set of groups. */
export type DeskAddress =
  | { readonly kind: 'switch' }
  | { readonly kind: 'level'; readonly steps: number }
  | { readonly kind: 'groups'; readonly count: number };

const SWITCH: DeskAddress = { kind: 'switch' };
const FADER: DeskAddress = { kind: 'level', steps: FADER_STEPS };
const SEND: DeskAddress = { kind: 'level', steps: SEND_STEPS };
const MUTE_GROUPS: DeskAddress = { kind: 'groups', count: 6 };
const DCAS: DeskAddress = { kind: 'groups', count: 8 };

const upTo = <T>(count: number, make: (n: number) => T): T[] => Array.from({ length: count }, (_, i) => make(i + 1));

/** Built by the same words that build changes, so the two can never disagree about what the desk has. */
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
    if (MIXED.test(strip)) {
      all.set(mainSend(strip, false).address, SWITCH);
      all.set(monoSend(strip, false).address, SWITCH);
      all.set(muteGroupsOf(strip, []).address, MUTE_GROUPS);
      all.set(dcasOf(strip, []).address, DCAS);
    }
    for (const to of destinations.filter((destination) => routes(strip, destination))) {
      all.set(sendOn(strip, to).address, SWITCH);
      all.set(sendLevel(strip, to, 0).address, SEND);
    }
  }
  for (const group of upTo(6, muteGroup)) all.set(group, SWITCH);
  return all;
})();

/** For a stand-in desk: what an address holds, or null for one the X32 lacks (a typo, a strip past its count). */
export function deskAddress(address: string): DeskAddress | null {
  return ADDRESSES.get(address) ?? null;
}
