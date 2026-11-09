import type { IncomingMessage, ServerResponse } from 'node:http';
import type Clock from './Clock.ts';
import { formatInstant } from '../utils/instant.ts';

/** `GET /time`: church time for programs that read it rather than set a clock by it. It changes nothing. */
export function createTimeDoor(clock: Clock) {
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    if (req.method !== 'GET' || new URL(req.url ?? '/', 'http://localhost').pathname !== '/time') return false;

    const offsetSec = clock.offset();
    const church = clock.now();
    const standard = new Date(church.getTime() - offsetSec * 1000);
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      // Note(yoochan.kim): a stage page on another address may read it; it is a clock, nothing to keep from anyone.
      'access-control-allow-origin': '*',
    });
    res.end(JSON.stringify({
      churchTime: withZone(church),
      churchEpochMs: church.getTime(),
      standardTime: withZone(standard),
      offsetSec,
    }));
    return true;
  };
}

/** The wire's instant with its zone, so a program elsewhere reads it as ISO 8601. */
function withZone(at: Date): string {
  const minutes = -at.getTimezoneOffset();
  const pad = (value: number): string => String(value).padStart(2, '0');
  const abs = Math.abs(minutes);
  return `${formatInstant(at)}${minutes >= 0 ? '+' : '-'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
