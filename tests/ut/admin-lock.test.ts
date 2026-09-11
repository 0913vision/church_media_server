import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { SocketTestHelper, ensureServer, stopServer, TEST_ADMIN_PASSWORD } from './test-helpers.ts';
import { RejectReason } from '../../server/protocol.ts';

before(() => ensureServer());

// Note(yoochan.kim): The admin lock is global state that persists across disconnects, so clear it
// after this file — otherwise a leftover lock would block writes in other test
// files sharing the server.
after(async () => {
  try {
    const admin = await connectAuthedAdmin();
    admin.write('adminLock', false);
    await new Promise((resolve) => setTimeout(resolve, 150));
    admin.disconnect();
  } catch {
    // Note(yoochan.kim): best effort
  }
  await stopServer();
});

async function connectAuthedAdmin(): Promise<SocketTestHelper> {
  const admin = new SocketTestHelper();
  await admin.open('test-admin');
  // Note(yoochan.kim): Success is reported as a per-connection attribute, not a bespoke event.
  const authed = admin.waitForState((patch) => patch.isAdmin !== undefined);
  admin.invoke('authenticate', { password: TEST_ADMIN_PASSWORD });
  assert.strictEqual((await authed).isAdmin, true);
  return admin;
}

describe('Admin Auth Tests', () => {
  test('the correct password grants admin rights on that connection', async () => {
    const admin = await connectAuthedAdmin();

    try {
      assert.strictEqual((await admin.read()).isAdmin, true);
    } finally {
      admin.disconnect();
    }
  });

  test('a wrong password is refused with a reason', async () => {
    const sock = new SocketTestHelper();
    try {
      await sock.open();
      const rejected = sock.waitForRejected('authenticate');
      sock.invoke('authenticate', { password: 'definitely-wrong' });

      assert.strictEqual(await rejected, RejectReason.INVALID_PASSWORD);
      assert.strictEqual((await sock.read()).isAdmin, false);
    } finally {
      sock.disconnect();
    }
  });

  test('authenticating still works while the admin lock is held', async () => {
    const admin = await connectAuthedAdmin();
    let second: SocketTestHelper | null = null;

    try {
      admin.write('adminLock', true);
      assert.strictEqual((await admin.waitForState((p) => p.adminLock !== undefined)).adminLock, true);

      // Note(yoochan.kim): Otherwise a held lock could never be released by anyone else.
      second = await connectAuthedAdmin();

      admin.write('adminLock', false);
      assert.strictEqual((await admin.waitForState((p) => p.adminLock !== undefined)).adminLock, false);
    } finally {
      admin.disconnect();
      second?.disconnect();
    }
  });
});

describe('Admin Lock Tests', () => {
  test('the lock blocks user writes and releasing it lets them through', async () => {
    const admin = await connectAuthedAdmin();
    const user = new SocketTestHelper();

    try {
      await user.open();

      admin.write('adminLock', true);
      assert.strictEqual((await admin.waitForState((p) => p.adminLock !== undefined)).adminLock, true);

      const blocked = user.waitForRejected('volume');
      user.write('volume', 42);
      assert.strictEqual(await blocked, RejectReason.ADMIN_LOCKED);

      admin.write('adminLock', false);
      assert.strictEqual((await admin.waitForState((p) => p.adminLock !== undefined)).adminLock, false);

      const allowed = user.waitForState((patch) => patch.volume !== undefined);
      user.write('volume', 50);
      assert.strictEqual((await allowed).volume, 50);
    } finally {
      admin.disconnect();
      user.disconnect();
    }
  });

  test('an admin can still write while the lock is on', async () => {
    const admin = await connectAuthedAdmin();

    try {
      admin.write('adminLock', true);
      assert.strictEqual((await admin.waitForState((p) => p.adminLock !== undefined)).adminLock, true);

      const changed = admin.waitForState((patch) => patch.volume !== undefined);
      admin.write('volume', 33);
      assert.strictEqual((await changed).volume, 33);

      admin.write('adminLock', false);
      assert.strictEqual((await admin.waitForState((p) => p.adminLock !== undefined)).adminLock, false);
    } finally {
      admin.disconnect();
    }
  });

  test('the lock is global: it outlives the setter and any admin can release it', async () => {
    const adminA = await connectAuthedAdmin();
    const observer = new SocketTestHelper();
    await observer.open();
    let adminB: SocketTestHelper | null = null;

    try {
      // Note(yoochan.kim): A turns the lock on — everyone, including the observer, sees it
      adminA.write('adminLock', true);
      assert.strictEqual((await observer.waitForState((p) => p.adminLock !== undefined)).adminLock, true);

      // Note(yoochan.kim): The setter disconnects: the global lock must persist, with no auto-release
      adminA.disconnect();
      assert.strictEqual(
        (await observer.read()).adminLock,
        true,
        'lock persists after the setting admin disconnects',
      );

      // Note(yoochan.kim): A different admin can release it, and everyone is told
      adminB = await connectAuthedAdmin();
      const released = observer.waitForState((patch) => patch.adminLock !== undefined);
      adminB.write('adminLock', false);
      assert.strictEqual((await released).adminLock, false, 'any admin can release the global lock');
    } finally {
      adminA.disconnect();
      observer.disconnect();
      adminB?.disconnect();
    }
  });

  test('a gate a person engaged lapses by itself, and never sits more than an hour out', async () => {
    const admin = await connectAuthedAdmin();
    const minutesUntil = (at: string): number => (new Date(at).getTime() - Date.now()) / 60_000;

    try {
      const idle = await admin.read();
      assert.deepStrictEqual(idle.adminHold, { kind: 'none' }, 'an open gate is due nothing');

      const closed = admin.waitForState((patch) => patch.adminHold !== undefined);
      admin.write('adminLock', true);
      const hold = (await closed).adminHold!;
      assert.strictEqual(hold.kind, 'at');
      const engagedAt = hold.kind === 'at' ? minutesUntil(hold.at) : NaN;
      assert.ok(Math.abs(engagedAt - 60) < 1, `an hour out, got ${engagedAt}`);

      // Note(yoochan.kim): pressing extend with nearly an hour left cannot buy an hour and a
      // half — the clamp is what makes "releases within the hour" true at every moment.
      const extended = admin.waitForState((patch) => patch.adminHold !== undefined);
      admin.invoke('extendAdminHold', {});
      const after = (await extended).adminHold!;
      const extendedTo = after.kind === 'at' ? minutesUntil(after.at) : NaN;
      assert.ok(extendedTo <= 60.1, `still inside the hour, got ${extendedTo}`);

      // Note(yoochan.kim): the lock announces itself in a patch of its own, so this waits on
      // what the write returned rather than expecting both in one.
      const opened = admin.waitForState((patch) => patch.adminHold?.kind === 'none');
      admin.write('adminLock', false);
      await opened;
      assert.strictEqual((await admin.read()).adminLock, false);

      const refused = admin.waitForRejected('extendAdminHold');
      admin.invoke('extendAdminHold', {});
      assert.strictEqual(await refused, RejectReason.ADMIN_UNLOCKED, 'nothing to extend');
    } finally {
      admin.write('adminLock', false);
      await new Promise((resolve) => setTimeout(resolve, 150));
      admin.disconnect();
    }
  });

  test('when the music stops is the gate holder\'s to set, and only theirs', async () => {
    const admin = await connectAuthedAdmin();
    const soon = (ms: number): string => {
      const at = new Date(Date.now() + ms);
      const pad = (v: number, w = 2): string => String(v).padStart(w, '0');
      return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
        `T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`;
    };

    try {
      const closedGate = admin.waitForRejected('musicEndsAt');
      admin.write('musicEndsAt', { kind: 'at', at: soon(600_000) });
      assert.strictEqual(await closedGate, RejectReason.ADMIN_UNLOCKED, 'no gate, no say');

      const held = admin.waitForState((patch) => patch.adminLock === true);
      admin.write('adminLock', true);
      await held;

      // Note(yoochan.kim): an end already gone by would fire the instant it landed, which
      // reads as the panel unlocking itself for no reason.
      const past = admin.waitForRejected('musicEndsAt');
      admin.write('musicEndsAt', { kind: 'at', at: soon(-60_000) });
      assert.strictEqual(await past, RejectReason.INVALID_VALUE);

      const set = admin.waitForState((patch) => patch.musicEndsAt !== undefined);
      admin.write('musicEndsAt', { kind: 'at', at: soon(600_000) });
      assert.strictEqual((await set).musicEndsAt!.kind, 'at');

      // Note(yoochan.kim): opening the gate gives everything back, this along with the rest.
      const opened = admin.waitForState((patch) => patch.musicEndsAt?.kind === 'undecided');
      admin.write('adminLock', false);
      await opened;
      assert.deepStrictEqual((await admin.read()).musicEndsAt, { kind: 'undecided' });
    } finally {
      admin.write('adminLock', false);
      await new Promise((resolve) => setTimeout(resolve, 150));
      admin.disconnect();
    }
  });
});
