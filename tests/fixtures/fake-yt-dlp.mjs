#!/usr/bin/env node
// Stands in for yt-dlp in tests: no network and no real video. The video id in
// the address picks the answer, and a success writes the silent fixture where
// yt-dlp would have put the converted mp3.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const output = args[args.indexOf('--output') + 1];
const url = new URL(args[args.indexOf('--') + 1]);
const id = url.hostname === 'youtu.be' ? url.pathname.slice(1) : url.searchParams.get('v');
const silence = path.join(path.dirname(fileURLToPath(import.meta.url)), 'silence.mp3');
const land = () => fs.copyFileSync(silence, output.replace('%(ext)s', 'mp3'));

switch (id) {
  case 'gone':
    // A download that got partway, as a real failure can leave behind.
    fs.writeFileSync(output.replace('%(ext)s', 'webm.part'), 'half a video');
    console.error('ERROR: [youtube] gone: Video unavailable');
    process.exit(1);
    break;
  case 'huge':
    console.log('[download] File is larger than max-filesize (999999999 bytes > 314572800 bytes). Aborting.');
    break;
  case 'slow':
    // The lines yt-dlp prints with --newline, spread out enough to be reported.
    [[0, '[download]  10.0% of  246.27KiB at 1.00MiB/s ETA 00:02'],
     [300, '[download]  60.0% of  246.27KiB at 1.00MiB/s ETA 00:01'],
     [600, '[download] 100% of  246.27KiB in 00:00:01 at 1.00MiB/s'],
     [900, `[ExtractAudio] Destination: ${output.replace('%(ext)s', 'mp3')}`]]
      .forEach(([at, line]) => setTimeout(() => console.log(line), at));
    setTimeout(land, 1500);
    break;
  default:
    land();
}
