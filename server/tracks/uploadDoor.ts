import fs from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ADMIN_CONFIG } from '../constants/authConfig.ts';
import { TRACK_CONFIG } from '../constants/trackConfig.ts';
import { verifyPassword } from '../auth/password.ts';
import type TrackLibrary from './TrackLibrary.ts';
import type Uploads from './Uploads.ts';
import { measureMp3 } from './probe.ts';
import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';

/** The header an upload carries the admin password in */
export const PASSWORD_HEADER = 'x-admin-password';

interface Reply {
  status: number;
  body?: Record<string, unknown>;
}

class TooLarge extends Error {}

/**
 * POST /uploads — takes in an mp3 and holds it for addTrack.
 *
 * Note(yoochan.kim): a door for bytes and nothing else, because a socket message is no
 * place for a file. Whether the file becomes a track is addTrack's to say,
 * through the protocol, so this never touches the library. The password rides a
 * header because the one caller is the admin web's backend, which holds it.
 */
export function createUploadDoor(library: TrackLibrary, uploads: Uploads) {
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    if (req.method !== 'POST' || req.url !== '/uploads') return false;

    receive(req, library, uploads)
      .catch((error: unknown): Reply => {
        log.error('uploads', null, 'Upload failed', { error: errorMessage(error) });
        return { status: 500 };
      })
      .then((reply) => {
        // Note(yoochan.kim): a body refused before it was read is still on its way;
        // reading it out lets the sender finish and hear the answer.
        if (!req.complete) req.resume();
        res.writeHead(reply.status, reply.body ? { 'content-type': 'application/json' } : {});
        res.end(reply.body ? JSON.stringify(reply.body) : undefined);
      });
    return true;
  };
}

async function receive(req: IncomingMessage, library: TrackLibrary, uploads: Uploads): Promise<Reply> {
  const password = req.headers[PASSWORD_HEADER];
  if (typeof password !== 'string' || !verifyPassword(password, ADMIN_CONFIG.ADMIN_PASSWORD_HASH)) {
    log.warn('uploads', null, 'Upload refused: wrong password');
    return { status: 401 };
  }
  if (Number(req.headers['content-length']) > TRACK_CONFIG.MAX_BYTES) {
    log.warn('uploads', null, 'Upload refused: too large', { declared: req.headers['content-length'] });
    return { status: 413 };
  }

  const staged = library.stagingPath();
  let kept = false;
  try {
    if (!(await save(req, staged, TRACK_CONFIG.MAX_BYTES))) {
      log.warn('uploads', null, 'Upload refused: too large');
      return { status: 413 };
    }
    const durationSec = await measureMp3(staged);
    if (durationSec === null) {
      log.warn('uploads', null, 'Upload refused: not an mp3');
      return { status: 415 };
    }

    kept = true;
    const upload = uploads.hold(staged, durationSec);
    log.info('uploads', null, 'Upload received', { upload, durationSec });
    return { status: 201, body: { upload } };
  } finally {
    if (!kept) fs.rmSync(staged, { force: true });
  }
}

/** Writes the body to `file`. False when it ran past `max`, having stopped writing there. */
async function save(req: IncomingMessage, file: string, max: number): Promise<boolean> {
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > max) return done(new TooLarge());
      done(null, chunk);
    },
  });
  // Note(yoochan.kim): a sender that gives up halfway never ends the body, so the write
  // would wait for it forever.
  req.on('close', () => {
    if (!req.complete) counter.destroy(new Error('Upload cut short'));
  });
  req.pipe(counter);

  try {
    await pipeline(counter, fs.createWriteStream(file));
    return true;
  } catch (error) {
    if (error instanceof TooLarge) return false;
    throw error;
  }
}
