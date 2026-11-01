/** A song's meter average and the volume it implies; pure, so it can be checked with made-up readings. */

import { dbFromLevel, levelFromDb } from '../hardware/loudness.ts';

/** EBU R128 judges loudness in blocks of 400ms; a desk meter is averaged the same way. */
const BLOCK_MS = 400;
/** Quieter than this is silence: the gap before a song, between songs, after it. */
const ABSOLUTE_GATE_DB = -70;
/** A block this far under the song's own average is a quiet passage, not the song. */
const RELATIVE_GATE_DB = -10;

const dbOf = (power: number): number => 10 * Math.log10(power);
const powerOf = (db: number): number => 10 ** (db / 10);
const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

/** Note(yoochan.kim): dBFS, R128-gated on power so silence and quiet parts don't drag it; no K-weighting, not LUFS. */
export class MeterAverage {
  private readonly blocks: number[] = [];
  private blockStart: number | null = null;
  private blockPowers: number[] = [];

  /** One meter frame: the linear readings (1 = full scale) of every channel watched, at a time in ms. */
  add(levels: readonly number[], atMs: number): void {
    if (levels.length === 0) return;
    if (this.blockStart === null) this.blockStart = atMs;
    if (atMs - this.blockStart >= BLOCK_MS) {
      this.closeBlock();
      this.blockStart = atMs;
    }
    // Note(yoochan.kim): two channels of one stereo source, so their power is averaged
    this.blockPowers.push(mean(levels.map((level) => level * level)));
  }

  /** The level of the last few seconds, for a screen to show while it runs. Null before anything was heard. */
  recentDb(seconds: number): number | null {
    const recent = this.blocks.slice(-Math.max(1, Math.round((seconds * 1000) / BLOCK_MS)));
    if (recent.length === 0) return null;
    return dbOf(Math.max(mean(recent), powerOf(-120)));
  }

  /** The gated average of everything so far. Null when nothing was loud enough to count. */
  averageDb(): number | null {
    this.closeBlock();
    const sounding = this.blocks.filter((power) => power >= powerOf(ABSOLUTE_GATE_DB));
    if (sounding.length === 0) return null;
    const floor = mean(sounding) * powerOf(RELATIVE_GATE_DB);
    const kept = sounding.filter((power) => power >= floor);
    return dbOf(mean(kept));
  }

  private closeBlock(): void {
    if (this.blockPowers.length === 0) return;
    this.blocks.push(mean(this.blockPowers));
    this.blockPowers = [];
  }
}

/** Note(yoochan.kim): a known dB curve needs one measurement; unclamped past 100 so out of reach says by how much. */
export function volumeFor(measuredAtVolume: number, measuredDb: number, targetDb: number): number {
  return levelFromDb(dbFromLevel(measuredAtVolume) + (targetDb - measuredDb));
}
