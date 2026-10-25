import 'dotenv/config';
import fs from 'node:fs';
import net from 'node:net';
import { requireEnv, requireIntEnv } from '../server/utils/env.ts';
import { dbFromCubicLevel, levelFromDb } from '../server/hardware/loudness.ts';

// Moves every stored level onto the fader-shaped scale (server/hardware/loudness.ts),
// each one kept as loud as it was. A level used to be mpv's cubic volume, so 50
// meant -18 dB; read on the new scale that is 53.
//
// Run once per deployment, with the media server stopped — a running one writes
// the old numbers back from memory. Each file is copied to <file>.before-x32-scale
// first; a copy already there means it was converted, and nothing is touched.
//
// Usage: npm run rescale-volumes

const BACKUP = '.before-x32-scale';

type Json = Record<string, unknown>;

/** The same loudness, read on the new scale. */
function rescale(what: string, level: unknown, changes: string[]): number {
  if (typeof level !== 'number' || !Number.isFinite(level)) {
    throw new Error(`${what}: not a level: ${JSON.stringify(level)}`);
  }
  const moved = Math.round(levelFromDb(dbFromCubicLevel(level)));
  changes.push(`${what}: ${level} -> ${moved}`);
  return moved;
}

function manifest(tracks: Json[], changes: string[]): void {
  for (const track of tracks) {
    track.volume = rescale(`track ${String(track.id)}`, track.volume, changes);
  }
}

function schedule(entries: Json[], changes: string[]): void {
  for (const entry of entries) {
    for (const part of entry.parts as { tracks: Json[] }[]) {
      for (const cue of part.tracks) {
        cue.volume = rescale(`flow ${String(entry.id)} track ${String(cue.id)}`, cue.volume, changes);
      }
    }
  }
}

function state(saved: Json, changes: string[]): void {
  saved.serverVolume = rescale('panel', saved.serverVolume, changes);
}

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

const port = requireIntEnv('PORT');
if (await listening(port)) {
  console.error(`rescale-volumes: something answers on port ${port}. Stop the media server first — a running one writes the old levels back.`);
  process.exit(1);
}

// Each written back the way the server writes it.
const pretty = (data: unknown): string => `${JSON.stringify(data, null, 2)}\n`;
const jobs: { file: string; convert: (data: never, changes: string[]) => void; write: (data: unknown) => string }[] = [
  { file: requireEnv('TRACKS_MANIFEST_PATH'), convert: manifest, write: pretty },
  { file: requireEnv('SCHEDULE_FILE_PATH'), convert: schedule, write: pretty },
  { file: requireEnv('STATE_FILE_PATH'), convert: state, write: (data) => JSON.stringify(data) },
];

// Note(yoochan.kim): every file is read and converted before any is written, so a
// file that is already done or will not parse leaves all three as they were.
const converted: { file: string; text: string; changes: string[] }[] = [];
for (const { file, convert, write } of jobs) {
  if (fs.existsSync(`${file}${BACKUP}`)) {
    console.error(`rescale-volumes: ${file}${BACKUP} exists — already converted. Nothing changed.`);
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.log(`rescale-volumes: ${file} is not there, skipped`);
    continue;
  }
  const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  const changes: string[] = [];
  convert(data as never, changes);
  converted.push({ file, text: write(data), changes });
}

for (const { file, text, changes } of converted) {
  fs.copyFileSync(file, `${file}${BACKUP}`, fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(`${file}.tmp`, text, 'utf8');
  fs.renameSync(`${file}.tmp`, file);
  console.log(`rescale-volumes: ${file}`);
  for (const change of changes) console.log(`  ${change}`);
}
