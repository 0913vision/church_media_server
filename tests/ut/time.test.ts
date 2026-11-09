import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { SocketTestHelper, ensureServer, stopServer, ownsServer, TEST_ADMIN_PASSWORD, TEST_PORT, TEST_NTP_PORT } from './test-helpers.ts';
import { askNtp } from './ntp-client.ts';

before(() => ensureServer());
after(() => stopServer());

const SLACK_MS = 200;

interface TimeReply {
  churchTime: string;
  churchEpochMs: number;
  standardTime: string;
  offsetSec: number;
}

async function getTime(): Promise<{ status: number; headers: Headers; body: TimeReply }> {
  const res = await fetch(`http://localhost:${TEST_PORT}/time`);
  return { status: res.status, headers: res.headers, body: (await res.json()) as TimeReply };
}

async function connectAuthedAdmin(): Promise<SocketTestHelper> {
  const admin = new SocketTestHelper();
  await admin.open('test-admin');
  const authed = admin.waitForState((patch) => patch.isAdmin !== undefined);
  admin.invoke('authenticate', { password: TEST_ADMIN_PASSWORD });
  assert.strictEqual((await authed).isAdmin, true);
  return admin;
}

describe('Church time for everyone else', () => {
  test('GET /time says church time, standard time and the correction, with their zone', async () => {
    const reader = new SocketTestHelper();
    const { state } = await reader.open();
    try {
      const asked = Date.now();
      const { status, headers, body } = await getTime();
      assert.equal(status, 200);
      assert.equal(headers.get('content-type'), 'application/json');
      assert.equal(headers.get('access-control-allow-origin'), '*', 'readable from a page on another address');
      assert.equal(body.offsetSec, state.clockOffsetSec, 'the correction the protocol reports');
      assert.match(body.churchTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
      assert.equal(Date.parse(body.churchTime), body.churchEpochMs, 'one instant, two spellings');
      assert.ok(Math.abs(body.churchEpochMs - (asked + body.offsetSec * 1000)) < SLACK_MS);
      assert.ok(Math.abs(Date.parse(body.standardTime) - asked) < SLACK_MS);
    } finally {
      reader.disconnect();
    }
  });

  test('a correction an admin makes is in both /time and NTP at once', async (t) => {
    const admin = await connectAuthedAdmin();
    try {
      const moved = admin.waitForState((patch) => patch.clockOffsetSec === 30);
      admin.write('clockOffsetSec', 30);
      await moved;

      const asked = Date.now();
      const { body } = await getTime();
      assert.equal(body.offsetSec, 30);
      assert.ok(Math.abs(body.churchEpochMs - (asked + 30_000)) < SLACK_MS, '/time 30s ahead');

      if (!ownsServer()) {
        t.diagnostic('NTP skipped: the server under test was started elsewhere, on a port this file does not know');
        return;
      }
      const reply = await askNtp(TEST_NTP_PORT);
      assert.ok(reply, 'NTP answered');
      assert.ok(Math.abs(reply.transmitMs - (Date.now() + 30_000)) < SLACK_MS, 'NTP 30s ahead');
    } finally {
      admin.write('clockOffsetSec', 0);
      await new Promise((resolve) => setTimeout(resolve, 150));
      admin.disconnect();
    }
  });

  test('only GET /time is the time', async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/time`, { method: 'POST' });
    assert.notEqual(res.status, 200);
  });
});
