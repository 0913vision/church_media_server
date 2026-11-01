import { test, describe, before, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

// Note(yoochan.kim): the logger reads LOG_LEVEL when it is loaded, so it is loaded after the
// level is set. Lines are caught on their way to console.log.
type Log = typeof import('../../server/utils/logger.ts').log;
let log: Log;

before(async () => {
  process.env.LOG_LEVEL = 'info';
  ({ log } = await import('../../server/utils/logger.ts'));
});

let lines: string[] = [];
const print = console.log;
beforeEach(() => {
  lines = [];
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
});
afterEach(() => {
  console.log = print;
});

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** Past the quiet that closes a run. */
const QUIET = 800;

describe('A log line', () => {
  test('carries the time to the millisecond, with its offset', () => {
    log.info('player', null, 'Play', { deck: 'song fervent' });
    assert.match(lines[0]!, /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}\]\[INFO\] Play \[module=player,deck=song fervent\]$/);
  });

  test('still gives the admin web\'s log screen the day and the second where it reads them', () => {
    log.warn('write', null, 'Write refused');
    // Note(yoochan.kim): SystemPanel.ts takes line.slice(1, 20) and splits it on the space.
    const [day, clock] = lines[0]!.slice(1, 20).split(' ');
    assert.match(day!, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(clock!, /^\d{2}:\d{2}:\d{2}$/);
  });
});

describe('A value moved in a run', () => {
  test('is one line: where it went, where it came from, in how many steps', async () => {
    log.drag('a:volume', 'write', null, 'Write', 30, { client: '패널', field: 'volume' });
    log.drag('a:volume', 'write', null, 'Write', 38, { client: '패널', field: 'volume' });
    log.drag('a:volume', 'write', null, 'Write', 47, { client: '패널', field: 'volume' });
    assert.deepEqual(lines, [], 'nothing while it is still moving');
    await settle(QUIET);

    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /Write \[module=write,client=패널,field=volume,value=47,from=30,steps=3,over=0\.\ds\]$/);
  });

  test('moved once, it reads as a plain line', async () => {
    log.drag('b:volume', 'write', null, 'Write', 47, { client: '패널', field: 'volume' });
    await settle(QUIET);
    assert.match(lines[0]!, /Write \[module=write,client=패널,field=volume,value=47\]$/);
  });

  test('is written before any other line, so the log keeps the order things happened in', () => {
    log.drag('c:volume', 'write', null, 'Write', 30, { client: '패널', field: 'volume' });
    log.drag('c:volume', 'write', null, 'Write', 47, { client: '패널', field: 'volume' });
    log.info('write', null, 'Write', { client: '패널', field: 'playback', value: 'playing' });

    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /field=volume,value=47,from=30,steps=2/);
    assert.match(lines[1]!, /field=playback,value=playing/);
  });

  test('is stamped with its last step, not with when it was written', async () => {
    log.drag('d:volume', 'write', null, 'Write', 30, {});
    const last = new Date();
    log.drag('d:volume', 'write', null, 'Write', 31, {});
    await settle(QUIET);
    const stamped = lines[0]!.slice(12, 24);
    const sec = (time: string): number => {
      const [h, m, s] = time.split(':').map(Number);
      return h! * 3600 + m! * 60 + s!;
    };
    const lastSec = last.getHours() * 3600 + last.getMinutes() * 60 + last.getSeconds() + last.getMilliseconds() / 1000;
    assert.ok(Math.abs(sec(stamped) - lastSec) < 0.1, `stamped ${stamped}, last step at ${last.toTimeString()}`);
  });
});
