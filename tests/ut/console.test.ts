import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { SocketTestHelper, ensureServer, stopServer, TEST_ADMIN_PASSWORD } from './test-helpers.ts';
import { RejectReason } from '../../server/protocol.ts';

before(() => ensureServer());
after(() => stopServer());

describe('Console readback', () => {
  // Note(yoochan.kim): the inputs are the desk's configuration, so a client
  // takes both the list and the names from here rather than holding its own.
  test('the console reports its inputs, named, in order', async () => {
    const sock = new SocketTestHelper();
    try {
      const { ready } = await sock.open('console-probe');
      assert.ok(ready.attributes.includes('console'));

      const inputs = (await sock.read()).console!;
      assert.ok(inputs.length > 0, 'at least one input');
      for (const input of inputs) {
        assert.strictEqual(typeof input.id, 'string');
        assert.ok(input.label.length > 0, 'every input is named for the screen');
        assert.ok(input.state.kind === 'read' || input.state.kind === 'unknown');
      }
    } finally {
      sock.disconnect();
    }
  });

  test('enabling an input is heard back as a console patch', async () => {
    const admin = new SocketTestHelper();
    try {
      await admin.open('console-probe');

      const authed = admin.waitForState((patch) => patch.isAdmin !== undefined);
      admin.invoke('authenticate', { password: TEST_ADMIN_PASSWORD });
      await authed;

      const target = (await admin.read()).console![0]!.id;
      const heard = admin.waitForState((patch) =>
        patch.console?.some((input) => input.id === target && input.state.kind === 'read' && input.state.on) === true,
      );
      admin.invoke('enableConsoleInput', { input: target });

      await heard;
    } finally {
      admin.disconnect();
    }
  });

  // Note(yoochan.kim): the mute group and the masters have no reading to assert
  // against — the desk is never asked what its matrix is at — so what this pins
  // is the part a client can see: every input ends up on, from one call.
  test('initializing the console leaves every input on', async () => {
    const admin = new SocketTestHelper();
    try {
      await admin.open('console-probe');

      const authed = admin.waitForState((patch) => patch.isAdmin !== undefined);
      admin.invoke('authenticate', { password: TEST_ADMIN_PASSWORD });
      await authed;

      const ids = (await admin.read()).console!.map((input) => input.id);
      const allOn = admin.waitForState((patch) =>
        ids.every((id) => {
          const input = patch.console?.find((candidate) => candidate.id === id);
          return input?.state.kind === 'read' && input.state.on;
        }),
      );
      admin.invoke('initializeConsole', {});

      await allOn;
    } finally {
      admin.disconnect();
    }
  });

  test('an input the desk does not have is refused', async () => {
    const sock = new SocketTestHelper();
    try {
      await sock.open('console-probe');

      const rejected = sock.waitForRejected('enableConsoleInput');
      sock.invoke('enableConsoleInput', { input: 'no-such-input' });

      assert.strictEqual(await rejected, RejectReason.INVALID_VALUE);
    } finally {
      sock.disconnect();
    }
  });
});
