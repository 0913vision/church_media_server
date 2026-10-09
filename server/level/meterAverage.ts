/**
 * Turning a desk meter into one number for a whole song, and that number into a
 * volume. Pure — no desk, no player — so it can be checked with made-up readings.
 */

/** EBU R128 judges loudness in blocks of 400ms; a desk meter is averaged the same way. */
const BLOCK_MS = 400;
/** Quieter than this is silence: the gap before a song, between songs, after it. */
const ABSOLUTE_GATE_DB = -70;
/** A block this far under the song's own average is a quiet passage, not the song. */
const RELATIVE_GATE_DB = -10;

const dbOf = (power: number): number => 10 * Math.log10(power);
const powerOf = (db: number): number => 10 ** (db / 10);
const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * The average level of what passed a meter, in dB relative to the desk's full
 * scale.
 *
 * Note(yoochan.kim): a song has loud and quiet parts, so a plain average lets the
 * quiet ones drag it down and the silence around it drag it further. This gates
 * the way EBU R128 does — silence out first, then the passages well under the
 * song's own average — and averages power, not decibels. The desk meter is not
 * K-weighted, so this is the R128 method on the desk's reading, not a LUFS figure.
 */
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

/**
 * The volume that moves a measured level onto a target.
 *
 * Note(yoochan.kim): mpv's volume is cubic — the gain is (v/100)³ — measured on
 * 2026-10-04: halving it took 18.1 dB off and halving again 18.0 dB. So one
 * measurement at a known volume is enough; there is nothing to chase.
 */
export function volumeFor(measuredAtVolume: number, measuredDb: number, targetDb: number): number {
  return measuredAtVolume * 10 ** ((targetDb - measuredDb) / 60);
}
