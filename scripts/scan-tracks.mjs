// Note(yoochan.kim): a flow's timeline is laid out from these durations, so a hand-typed one skews the schedule.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const manifestPath = process.argv[2] ?? process.env.TRACKS_MANIFEST_PATH ?? './assets/tracks.json';
const manifestDir = path.dirname(manifestPath);

// Note(yoochan.kim): ffmpeg decodes the file and never opens an audio device, so this makes no sound.
// Note(yoochan.kim): the decoded audio, not the header: an mp3's header counts its padding, which mpv trims, so a run ran on 10–90ms early.
function measureSeconds(file) {
  // Note(yoochan.kim): decoded to 1kHz mono, one byte a millisecond, as server/tracks/probe.ts counts it.
  const output = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '1000', '-f', 'u8', '-'],
    { maxBuffer: 256 * 1024 * 1024 },
  );
  if (output.length === 0) {
    throw new Error(`ffmpeg decoded no audio from ${file}`);
  }
  return output.length / 1000;
}

try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  console.error('scan-tracks: ffmpeg not found. Install it, or edit durationSec by hand and keep it exact.');
  process.exit(1);
}

const tracks = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (!Array.isArray(tracks)) {
  console.error(`scan-tracks: ${manifestPath} must be a JSON array`);
  process.exit(1);
}

let changed = 0;
for (const track of tracks) {
  const file = path.resolve(manifestDir, track.file);
  if (!fs.existsSync(file)) {
    console.error(`scan-tracks: ${track.id}: file not found at ${file}`);
    process.exit(1);
  }

  const measured = measureSeconds(file);
  const previous = track.durationSec;
  track.durationSec = measured;

  if (previous === measured) {
    console.log(`scan-tracks: ${track.id} ${measured}s (unchanged)`);
  } else {
    changed += 1;
    const drift = typeof previous === 'number' ? ` (was ${previous}s, off by ${Math.round((measured - previous) * 1000)}ms)` : '';
    console.log(`scan-tracks: ${track.id} ${measured}s${drift}`);
  }
}

fs.writeFileSync(manifestPath, `${JSON.stringify(tracks, null, 2)}\n`, 'utf8');
console.log(`scan-tracks: wrote ${manifestPath}${changed ? ` — ${changed} corrected` : ' — all already correct'}`);
