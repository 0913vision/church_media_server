import fs from 'node:fs';
import path from 'node:path';

/** A playable library entry (file path stays server-side) */
export interface Track {
  id: string;
  title: string;
  file: string;
  durationSec: number;
}

/** The client-facing slice of a track (no file system details) */
export interface TrackInfo {
  id: string;
  title: string;
  durationSec: number;
}

/**
 * Track library for scheduled flows: loads a JSON manifest
 * (`[{ id, title, file, durationSec }]`, file paths relative to the manifest)
 * at boot and fails fast on any invalid entry, matching the server's
 * no-defaults policy. The two-song system is untouched — this is an
 * additional catalog for admin-driven sequences.
 */
class TrackLibrary {
  private readonly tracks = new Map<string, Track>();

  constructor(manifestPath: string) {
    const manifestDir = path.dirname(manifestPath);
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!Array.isArray(parsed)) {
      throw new Error(`Track manifest must be a JSON array: ${manifestPath}`);
    }

    for (const entry of parsed) {
      const { id, title, file, durationSec } = entry as Record<string, unknown>;
      if (typeof id !== 'string' || id.length === 0 ||
          typeof title !== 'string' || title.length === 0 ||
          typeof file !== 'string' || file.length === 0 ||
          typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0) {
        throw new Error(`Invalid track entry in manifest: ${JSON.stringify(entry)}`);
      }
      if (this.tracks.has(id)) {
        throw new Error(`Duplicate track id in manifest: ${id}`);
      }
      const resolvedFile = path.resolve(manifestDir, file);
      if (!fs.existsSync(resolvedFile)) {
        throw new Error(`Track file not found: ${resolvedFile} (track ${id})`);
      }
      this.tracks.set(id, { id, title, file: resolvedFile, durationSec });
    }
  }

  list(): TrackInfo[] {
    return [...this.tracks.values()].map(({ id, title, durationSec }) => ({ id, title, durationSec }));
  }

  get(id: string): Track | undefined {
    return this.tracks.get(id);
  }
}

export default TrackLibrary;
