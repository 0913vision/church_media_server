/** No silent defaults: a missing or malformed value stops boot naming the variable, rather than running oddly. */

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
