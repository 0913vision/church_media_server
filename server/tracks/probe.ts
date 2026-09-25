import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The length of an mp3 in seconds, or null when the file is not one.
 *
 * Note(yoochan.kim): ffprobe reads the container and never opens an audio device, so
 * measuring cannot make a sound. Rounded to a tenth like scan-tracks, which is
 * well inside the seek tolerance.
 */
export async function measureMp3(file: string): Promise<number | null> {
  let stdout: string;
  try {
    ({ stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=format_name,duration', '-of', 'json', file]));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('ffprobe not found');
    return null;
  }

  const format = (JSON.parse(stdout) as { format?: { format_name?: string; duration?: string } }).format;
  const seconds = Number.parseFloat(format?.duration ?? '');
  if (format?.format_name !== 'mp3' || !Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds * 10) / 10;
}
