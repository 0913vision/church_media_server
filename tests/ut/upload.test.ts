import { test, describe, before, after } from 'node:test';
import type { TestContext } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  SocketTestHelper, ensureServer, stopServer, ownsServer,
  TEST_ADMIN_PASSWORD, TEST_PORT, TEST_AUDIO_DIR, TEST_TRACKS_MANIFEST_PATH,
} from './test-helpers.ts';
import { RejectReason } from '../../server/protocol.ts';
import type { Track } from '../../server/protocol.ts';

before(() => ensureServer());
after(() => stopServer());

// Note(yoochan.kim): every file sent here is a one-second silent mp3 or plain junk, and
// nothing is ever played, so none of this reaches the room.
const SILENCE = fs.readFileSync(path.resolve('./tests/fixtures/silence.mp3'));

async function send(body: Buffer, password = TEST_ADMIN_PASSWORD): Promise<{ status: number; upload?: string }> {
  const res = await fetch(`http://localhost:${TEST_PORT}/uploads`, {
    method: 'POST',
    headers: { 'x-admin-password': password },
    body: new Uint8Array(body),
  });
  const text = await res.text();
  return { status: res.status, ...(text ? (JSON.parse(text) as { upload: string }) : {}) };
}

/** Declares a body past the limit and sends none of it: the door must answer from the header. */
function declareTooLarge(): Promise<number> {
  return new Promise((resolve, reject) => {
    let answered = false;
    const req = http.request({
      host: 'localhost',
      port: TEST_PORT,
      path: '/uploads',
      method: 'POST',
      headers: { 'x-admin-password': TEST_ADMIN_PASSWORD, 'content-length': String(301 * 1024 * 1024) },
    }, (res) => {
      answered = true;
      resolve(res.statusCode ?? 0);
      res.resume();
      req.destroy();
    });
    req.on('error', (error) => { if (!answered) reject(error); });
    req.flushHeaders();
  });
}

/** Files still waiting in the audio folder for addTrack */
function waiting(): string[] {
  return fs.readdirSync(TEST_AUDIO_DIR).filter((name) => name.startsWith('.incoming-'));
}

async function connectAuthedAdmin(client: string): Promise<SocketTestHelper> {
  const admin = new SocketTestHelper();
  await admin.open(client);
  const authed = admin.waitForState((patch) => patch.isAdmin !== undefined);
  admin.invoke('authenticate', { password: TEST_ADMIN_PASSWORD });
  await authed;
  return admin;
}

/** The files these tests look at are the in-process server's; one started elsewhere has its own. */
function ownServer(t: TestContext): boolean {
  if (!ownsServer()) t.skip('the server under test was started elsewhere');
  return ownsServer();
}

async function removeTrack(admin: SocketTestHelper, id: string): Promise<void> {
  const gone = admin.waitForState((patch) => patch.tracks !== undefined);
  admin.invoke('deleteTrack', { id });
  await gone;
}

describe('Uploading a track', () => {
  test('the door takes an mp3 in and changes nothing about the device', async (t) => {
    if (!ownServer(t)) return;
    const sock = new SocketTestHelper();
    try {
      await sock.open('upload-observer');
      const before = (await sock.read()).tracks!;
      const waitingBefore = waiting().length;

      const quiet = sock.expectNoState((patch) => patch.tracks !== undefined, 500);
      const answer = await send(SILENCE);
      assert.strictEqual(answer.status, 201);
      assert.match(answer.upload ?? '', /^u-[0-9a-f]+$/);
      assert.ok(await quiet, 'an upload is not a track, so nobody is told of one');

      assert.deepStrictEqual((await sock.read()).tracks, before);
      assert.strictEqual(waiting().length, waitingBefore + 1, 'it waits in the audio folder');
    } finally {
      sock.disconnect();
    }
  });

  test('a wrong password, a file too large and anything but an mp3 are turned away at the door', async (t) => {
    if (!ownServer(t)) return;
    const waitingBefore = waiting().length;

    assert.strictEqual((await send(SILENCE, 'wrong')).status, 401);
    assert.strictEqual(await declareTooLarge(), 413);
    assert.strictEqual((await send(Buffer.from('not audio at all'))).status, 415);
    assert.strictEqual((await send(Buffer.alloc(4096, 7))).status, 415);

    assert.strictEqual(waiting().length, waitingBefore, 'nothing refused is left behind');
  });

  test('addTrack keeps the upload for good, and every client is told at once', async (t) => {
    if (!ownServer(t)) return;
    const admin = await connectAuthedAdmin('upload-admin');
    const observer = new SocketTestHelper();
    try {
      await observer.open('upload-observer');
      const { upload } = await send(SILENCE);
      const before = new Set((await admin.read()).tracks!.map((track) => track.id));

      const told = observer.waitForState((patch) => patch.tracks !== undefined);
      admin.invoke('addTrack', { title: '  새 곡 ', source: { kind: 'upload', upload } });
      const added = (await told).tracks!.filter((track) => !before.has(track.id));

      assert.strictEqual(added.length, 1, 'another screen sees the new track without asking');
      const track: Track = added[0]!;
      assert.strictEqual(track.title, '새 곡');
      assert.strictEqual(track.volume, 50, 'every new track starts at the same level');
      assert.ok(track.durationSec > 1 && track.durationSec < 1.2, `measured from the file: ${track.durationSec}`);

      // Note(yoochan.kim): what the next boot reads, not what this process remembers.
      const manifest = JSON.parse(fs.readFileSync(TEST_TRACKS_MANIFEST_PATH, 'utf8')) as { id: string; file: string }[];
      const saved = manifest.find((entry) => entry.id === track.id);
      assert.ok(saved, 'the manifest names it');
      const file = path.resolve(path.dirname(TEST_TRACKS_MANIFEST_PATH), saved.file);
      assert.strictEqual(path.dirname(file), TEST_AUDIO_DIR, 'its audio lives in the library folder');
      assert.deepStrictEqual(fs.readFileSync(file), SILENCE, 'byte for byte what was sent');

      const again = admin.waitForRejected('addTrack');
      admin.invoke('addTrack', { title: '또', source: { kind: 'upload', upload } });
      assert.strictEqual(await again, RejectReason.UNKNOWN_UPLOAD, 'an upload becomes one track only');

      await removeTrack(admin, track.id);
      assert.strictEqual(fs.existsSync(file), false);
    } finally {
      admin.disconnect();
      observer.disconnect();
    }
  });

  test('a name is required, and asking without one keeps the upload for the next try', async (t) => {
    if (!ownServer(t)) return;
    const admin = await connectAuthedAdmin('upload-admin');
    const anyone = new SocketTestHelper();
    try {
      await anyone.open('upload-anyone');
      const { upload } = await send(SILENCE);

      const notAdmin = anyone.waitForRejected('addTrack');
      anyone.invoke('addTrack', { title: '누구나', source: { kind: 'upload', upload } });
      assert.strictEqual(await notAdmin, RejectReason.NOT_ADMIN);

      const taken = (await admin.read()).tracks![0]!.title;
      const cases: [Record<string, unknown>, RejectReason][] = [
        [{ title: '   ', source: { kind: 'upload', upload } }, RejectReason.INVALID_VALUE],
        [{ title: taken, source: { kind: 'upload', upload } }, RejectReason.TITLE_TAKEN],
        [{ source: { kind: 'upload', upload } }, RejectReason.INVALID_VALUE],
        [{ title: '곡', source: { kind: 'somewhere', upload } }, RejectReason.INVALID_VALUE],
        [{ title: '곡', source: { kind: 'upload', upload: 'u-0000' } }, RejectReason.UNKNOWN_UPLOAD],
      ];
      for (const [args, reason] of cases) {
        const refused = admin.waitForRejected('addTrack');
        admin.invoke('addTrack', args);
        assert.strictEqual(await refused, reason, JSON.stringify(args));
      }

      const added = admin.waitForState((patch) => patch.tracks !== undefined);
      admin.invoke('addTrack', { title: '이름 붙인 곡', source: { kind: 'upload', upload } });
      const track = (await added).tracks!.find((each) => each.title === '이름 붙인 곡');
      assert.ok(track, 'the upload was still there after every refusal');

      await removeTrack(admin, track.id);
    } finally {
      admin.disconnect();
      anyone.disconnect();
    }
  });
});
