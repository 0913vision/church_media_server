import { test, describe, before, after } from 'node:test';
import type { TestContext } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  SocketTestHelper, ensureServer, stopServer, ownsServer, TEST_ADMIN_PASSWORD, TEST_AUDIO_DIR, TEST_TRACKS_MANIFEST_PATH,
} from './test-helpers.ts';
import { RejectReason } from '../../server/protocol.ts';

before(() => ensureServer());
after(() => stopServer());

// Note(yoochan.kim): yt-dlp is a stand-in here (tests/fixtures/fake-yt-dlp.mjs), so
// nothing reaches YouTube, and what it lands is the one-second silent fixture.

async function connectAuthedAdmin(client: string): Promise<SocketTestHelper> {
  const admin = new SocketTestHelper();
  await admin.open(client);
  const authed = admin.waitForState((patch) => patch.isAdmin !== undefined);
  admin.invoke('authenticate', { password: TEST_ADMIN_PASSWORD });
  await authed;
  return admin;
}

/** The stand-in is only wired into the in-process server. */
function ownServer(t: TestContext): boolean {
  if (!ownsServer()) t.skip('the server under test was started elsewhere');
  return ownsServer();
}

function fromYoutube(title: string, url: string): Record<string, unknown> {
  return { title, source: { kind: 'youtube', url } };
}

/** Files a fetch left in the audio folder */
function leftovers(): string[] {
  return fs.readdirSync(TEST_AUDIO_DIR).filter((name) => name.startsWith('.incoming-'));
}

describe('Fetching a track from YouTube', () => {
  test('nothing is fetching until somebody asks', async () => {
    const sock = new SocketTestHelper();
    try {
      const { ready, state } = await sock.open('fetch-observer');
      assert.ok(ready.attributes.includes('trackFetch'));
      assert.deepStrictEqual(state.trackFetch, { kind: 'idle' });
    } finally {
      sock.disconnect();
    }
  });

  test('a fetched video is kept for good, and every screen sees it coming and arriving', async (t) => {
    if (!ownServer(t)) return;
    const admin = await connectAuthedAdmin('fetch-admin');
    const observer = new SocketTestHelper();
    try {
      await observer.open('fetch-observer');
      const before = new Set((await admin.read()).tracks!.map((track) => track.id));

      const heard = observer.collectStates(3000);
      const coming = observer.waitForState((patch) => patch.trackFetch?.kind === 'fetching');
      const arrived = observer.waitForState((patch) => patch.tracks !== undefined);
      admin.invoke('addTrack', fromYoutube(' 유튜브 곡 ', 'https://youtu.be/slow'));

      assert.deepStrictEqual((await coming).trackFetch, { kind: 'fetching', title: '유튜브 곡', progress: { stage: 'starting' } });

      // Note(yoochan.kim): while one is on its way, a second is refused rather than queued.
      const busy = admin.waitForRejected('addTrack');
      admin.invoke('addTrack', fromYoutube('또', 'https://www.youtube.com/watch?v=ok'));
      assert.strictEqual(await busy, RejectReason.FETCH_BUSY);

      const patch = await arrived;
      assert.deepStrictEqual(patch.trackFetch, { kind: 'idle' }, 'the fetch ends in the patch that brings the track');

      // Note(yoochan.kim): the stand-in prints 10%, 60% and 100% within a second, then
      // converts. A new stage is told at once and a percentage at most once a second,
      // so every screen hears exactly this.
      const told = (await heard).flatMap((each) => (each.trackFetch ? [each.trackFetch] : []));
      assert.deepStrictEqual(told, [
        { kind: 'fetching', title: '유튜브 곡', progress: { stage: 'starting' } },
        { kind: 'fetching', title: '유튜브 곡', progress: { stage: 'downloading', percent: 10 } },
        { kind: 'fetching', title: '유튜브 곡', progress: { stage: 'converting' } },
        { kind: 'idle' },
      ]);
      const added = patch.tracks!.filter((track) => !before.has(track.id));
      assert.strictEqual(added.length, 1);
      assert.strictEqual(added[0]!.title, '유튜브 곡');
      assert.strictEqual(added[0]!.volume, 50);

      const manifest = JSON.parse(fs.readFileSync(TEST_TRACKS_MANIFEST_PATH, 'utf8')) as { id: string; file: string }[];
      const saved = manifest.find((entry) => entry.id === added[0]!.id);
      assert.ok(saved, 'the manifest names it');
      assert.ok(fs.existsSync(path.resolve(path.dirname(TEST_TRACKS_MANIFEST_PATH), saved.file)));
      assert.deepStrictEqual(leftovers(), []);

      const gone = admin.waitForState((next) => next.tracks !== undefined);
      admin.invoke('deleteTrack', { id: added[0]!.id });
      await gone;
    } finally {
      admin.disconnect();
      observer.disconnect();
    }
  });

  test('what cannot be fetched is refused, and leaves nothing behind', async (t) => {
    if (!ownServer(t)) return;
    const admin = await connectAuthedAdmin('fetch-admin');
    try {
      const taken = (await admin.read()).tracks![0]!.title;
      const cases: [Record<string, unknown>, RejectReason][] = [
        [fromYoutube(taken, 'https://youtu.be/ok'), RejectReason.TITLE_TAKEN],
        [fromYoutube('곡', 'https://example.com/watch?v=ok'), RejectReason.INVALID_VALUE],
        [fromYoutube('곡', 'not an address'), RejectReason.INVALID_VALUE],
        [fromYoutube('   ', 'https://youtu.be/ok'), RejectReason.INVALID_VALUE],
        [{ title: '곡', source: { kind: 'youtube' } }, RejectReason.INVALID_VALUE],
        [fromYoutube('곡', 'https://youtu.be/gone'), RejectReason.FETCH_FAILED],
        [fromYoutube('곡', 'https://youtu.be/huge'), RejectReason.TOO_LARGE],
      ];
      for (const [args, reason] of cases) {
        const refused = admin.waitForRejected('addTrack', 5000);
        admin.invoke('addTrack', args);
        assert.strictEqual(await refused, reason, JSON.stringify(args));
      }

      assert.deepStrictEqual(leftovers(), [], 'a half download is cleared with the refusal');
      assert.deepStrictEqual((await admin.read()).trackFetch, { kind: 'idle' });
    } finally {
      admin.disconnect();
    }
  });
});
