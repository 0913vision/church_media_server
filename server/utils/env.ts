/**
 * Explicit, fail-fast environment access.
 *
 * Every required variable must be present (and valid) at startup — there are
 * no silent defaults. A missing or malformed value aborts boot with a message
 * naming the exact variable, instead of running with surprising behavior.
 */

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function requireIntEnv(name: string): number {
  const raw = requireEnv(name);
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  }
  return value;
}

export function requireEnvOneOf<T extends string>(name: string, allowed: readonly T[]): T {
  const raw = requireEnv(name);
  const matched = allowed.find((candidate) => candidate === raw);
  if (matched === undefined) {
    throw new Error(`Environment variable ${name} must be one of [${allowed.join(', ')}], got "${raw}"`);
  }
  return matched;
}
