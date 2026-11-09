import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';

// Note(yoochan.kim): the logger reads its level as it loads, so it is set before the server modules come in.
process.env.LOG_LEVEL ??= 'warn';
const { default: Clock } = await import('../../server/clock/Clock.ts');
const { default: NtpServer } = await import('../../server/clock/NtpServer.ts');
const { askNtp } = await import('./ntp-client.ts');

const clock = new Clock(12.5);
let server: InstanceType<typeof NtpServer>;
let port = 0;

before(async () => {
  server = new NtpServer(clock, 0);
  port = await server.listening;
});
after(() => server.dispose());

/** Within this of the church time worked out here: the answer is made on the same machine a moment later. */
const SLACK_MS = 60;

describe('NTP with church time', () => {
  test('a client is answered with church time, its own transmit time handed back as the origin', async () => {
    clock.setOffset(12.5);
    const asked = Date.now();
    const reply = await askNtp(port);
    assert.ok(reply, 'answered');
    assert.equal(reply.mode, 4, 'as a server');
    assert.equal(reply.version, 4);
    assert.equal(reply.leap, 0);
    assert.equal(reply.stratum, 3);
    assert.equal(reply.poll, 6, 'the poll asked for comes back');
    assert.equal(reply.origin.toString('ascii'), 'ORIGIN!!');
    assert.ok(Math.abs(reply.transmitMs - (asked + 12_500)) < SLACK_MS, `church time, ${reply.transmitMs - asked}ms ahead of standard`);
    assert.ok(reply.receiveMs <= reply.transmitMs, 'received before it was sent');
  });

  test('an NTP v3 client is answered in v3', async () => {
    const reply = await askNtp(port, { version: 3 });
    assert.equal(reply?.version, 3);
  });

  test('a correction made on the clock is in the next answer', async () => {
    clock.setOffset(-30);
    const asked = Date.now();
    const reply = await askNtp(port);
    assert.ok(reply && Math.abs(reply.transmitMs - (asked - 30_000)) < SLACK_MS, '30s behind standard');
    clock.setOffset(12.5);
  });

  test('nothing but a client question is answered', async () => {
    assert.equal(await askNtp(port, { mode: 6 }), null, 'a control query');
    assert.equal(await askNtp(port, { mode: 4 }), null, 'another server');
    assert.equal(await askNtp(port, { bytes: 20 }), null, 'a packet too short to be NTP');
  });
});
