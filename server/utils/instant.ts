/** One spelling only: hand-installed panels parse this form and nothing else, so reads and writes both use it. */
export const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/;

/** Local wall-clock with no zone: church time is the wall's clock, and everyone shares one building. */
export function formatInstant(at: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`;
}

export function isWireInstant(value: unknown): value is string {
  return typeof value === 'string' && INSTANT_PATTERN.test(value);
}
