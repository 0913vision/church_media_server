/**
 * The one shape an instant takes on this wire: `2026-08-05T19:30:00.000`.
 *
 * Local wall-clock time, milliseconds always, no zone marker. Server, admin web
 * and panels all stand in one building on one clock, so an offset would be the
 * same constant on every line — and church time is a wall clock rather than a
 * point pinned to UTC anyway. The digits on the wire are the digits on the wall.
 *
 * Pinned to a single spelling because the panel app is installed by hand on
 * mounted devices: it parses this form and nothing else, so a server that one
 * day wrote the same instant differently would break screens nobody can easily
 * update. Both directions go through here — `formatInstant` to write,
 * `isWireInstant` to refuse anything else on the way in.
 */
export const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/;

export function formatInstant(at: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`;
}

export function isWireInstant(value: unknown): value is string {
  return typeof value === 'string' && INSTANT_PATTERN.test(value);
}
