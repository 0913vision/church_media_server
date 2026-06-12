/**
 * Extracts a readable message from an unknown thrown value.
 * Used in catch blocks now that catch variables are strictly `unknown`.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
