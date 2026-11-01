// Note(yoochan.kim): a flow's timeline is laid out from these durations, so a hand-typed one skews the schedule.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const manifestPath = process.argv[2] ?? process.env.TRACKS_MANIFEST_PATH ?? './assets/tracks.json';
const manifestDir = path.dirname(manifestPath);

// Note(yoochan.kim): ffprobe reads only the file's header and never opens an audio device, so this makes no sound.
function measureSeconds(file) {
  const output = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file],
    { encoding: 'utf8' },
  );
  const seconds = Number.parseFloat(output.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`ffprobe reported no usable duration for ${file}`);
  }
  // Note(yoochan.kim): one decimal is well inside the seek tolerance and keeps the file readable.
  return Math.round(seconds * 10) / 10;
}

try {
  execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
} catch {
  console.error('scan-tracks: ffprobe not found. Install ffmpeg, or edit durationSec by hand and keep it exact.');
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
    const drift = typeof previous === 'number' ? ` (was ${previous}s, off by ${(measured - previous).toFixed(1)}s)` : '';
    console.log(`scan-tracks: ${track.id} ${measured}s${drift}`);
  }
}

fs.writeFileSync(manifestPath, `${JSON.stringify(tracks, null, 2)}\n`, 'utf8');
console.log(`scan-tracks: wrote ${manifestPath}${changed ? ` — ${changed} corrected` : ' — all already correct'}`);
