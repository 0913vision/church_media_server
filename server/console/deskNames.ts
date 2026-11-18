import { CONSOLE_CONFIG } from '../constants/consoleConfig.ts';
import type { ConsoleInputConfig } from '../constants/consoleConfig.ts';
import type { DeskSetting } from '../protocol.ts';

const KINDS: Record<string, string> = { ch: 'Ch', auxin: 'Aux', fxrtn: 'FX Return', bus: 'Bus', mtx: 'Matrix', dca: 'DCA' };
const STRIP = /^(\/(ch|auxin|fxrtn|bus|mtx|dca)\/(\d+)|\/main\/(st|m)|\/config\/mute\/(\d+))(.*)$/;

/** An address as a person at the X32 finds it: the strip, and the setting on it, in the desk's own English. */
export function deskSetting(address: string): DeskSetting {
  const match = STRIP.exec(address);
  if (!match) return { strip: address, setting: '' };
  const [, prefix, kind, number, main, group, rest] = match;
  if (group) return { strip: `Mute Group ${Number(group)}`, setting: '' };
  const strip = CONSOLE_CONFIG.STRIP_NAMES[prefix!]
    ?? (main ? (main === 'st' ? 'Main LR' : 'Mono') : `${KINDS[kind!]} ${Number(number)}`);
  return { strip, setting: settingOf(rest!, kind === 'bus' || main !== undefined) };
}

const ORDER = ['ch', 'auxin', 'fxrtn', 'bus', 'mtx', 'st', 'm', 'dca'];

/** Where an address's strip sits on the X32, inputs first and outputs last, so a list of them reads as the desk does. */
export function stripRank(address: string): number {
  const match = STRIP.exec(address);
  if (!match) return Number.MAX_SAFE_INTEGER;
  const [, , kind, number, main, group] = match;
  if (group) return (ORDER.length + 1) * 100 + Number(group);
  return ORDER.indexOf(kind ?? main!) * 100 + Number(number ?? 0);
}

/** Sends from a bus or the mains go to matrices; from anything else, to buses. */
function settingOf(rest: string, feedsMatrices: boolean): string {
  const send = /^\/mix\/(\d+)\/(on|level)$/.exec(rest);
  if (send) return `${feedsMatrices ? 'Matrix' : 'Bus'} ${Number(send[1])} Send${send[2] === 'level' ? ' Level' : ''}`;
  const named: Record<string, string> = {
    '/mix/on': 'Mute', '/on': 'Mute', '/mix/fader': 'Fader', '/fader': 'Fader',
    '/mix/st': 'Main LR', '/mix/mono': 'Mono', '/grp/mute': 'Mute Group', '/grp/dca': 'DCA',
  };
  return named[rest] ?? rest;
}

/** The strips an input drives, by the same names, so a screen can match it against what the server holds. */
export function stripsOf(input: ConsoleInputConfig): string[] {
  return [...new Set(input.CHANNELS.map((channel) => deskSetting(channel.ON_ADDRESS).strip))];
}
