import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Note(yoochan.kim): ffprobe and ffmpeg read the file and never open an audio device, so measuring cannot make a sound. */
export async function measureMp3(file: string): Promise<number | null> {
  let stdout: string;
  try {
    ({ stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=format_name', '-of', 'json', file]));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('ffprobe not found');
    return null;
  }

  const format = (JSON.parse(stdout) as { format?: { format_name?: string } }).format;
  if (format?.format_name !== 'mp3') return null;
  const seconds = await playedSeconds(file);
  return seconds !== null && seconds > 0 ? seconds : null;
}

/** How long a file plays for, to the millisecond: its decoded audio counted, as mpv plays it, without the padding its header counts. */
export function playedSeconds(file: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    // Note(yoochan.kim): decoded to 1kHz mono, one byte a millisecond, so a three-hour file is 11MB to count and never held.
    const child = spawn('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '1000', '-f', 'u8', '-'],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    let bytes = 0;
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') reject(new Error('ffmpeg not found'));
      else resolve(null);
    });
    child.on('close', (code) => resolve(code === 0 && bytes > 0 ? bytes / 1000 : null));
  });
}
