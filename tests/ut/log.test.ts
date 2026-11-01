import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { SocketTestHelper, ensureServer, stopServer, ownsServer } from './test-helpers.ts';
import { MuteState, PlaybackState } from '../../server/protocol.ts';

before(() => ensureServer());
after(() => stopServer());

// Note(yoochan.kim): a post-mortem has only the log to say who pressed what and what the deck did; muted, so silent.
describe('Reading back what happened from the log', () => {
  test('a volume dragged then play pressed: who, the run of values, the press, and how the deck started', async (t) => {
    if (!ownsServer() || ['warn', 'error'].includes(process.env.LOG_LEVEL ?? '')) {
      t.skip('needs the in-process server logging at info');
      return;
    }
    const lines: string[] = [];
    const print = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')); print(...args); };
    const panel = new SocketTestHelper();
    try {
      await panel.open('로그 시험 패널');
      const muted = panel.waitForState((patch) => patch.mute !== undefined);
      panel.write('mute', MuteState.MUTED);
      await muted;
      const before = await panel.read();
      const start = before.volume === undefined || before.volume > 90 ? 50 : before.volume;

      for (const step of [1, 2, 3]) {
        const moved = panel.waitForState((patch) => patch.volume === start + step);
        panel.write('volume', start + step);
        await moved;
      }
      const freed = panel.waitForState((patch) => patch.audioLock === false, 8000);
      panel.write('playback', PlaybackState.PLAYING);
      await freed;

      const find = (what: string, ...parts: string[]): number => {
        const at = lines.findIndex((line) => parts.every((part) => line.includes(part)));
        assert.ok(at >= 0, `no line for ${what} among:\n${lines.join('\n')}`);
        return at;
      };
      const drag = find('the drag', '] Write [', 'client=로그 시험 패널', 'field=volume',
        `value=${start + 3}`, `from=${start + 1}`, 'steps=3');
      const press = find('the press', '] Write [', 'client=로그 시험 패널', 'field=playback', 'value=playing');
      const play = find('what the deck did', '] Play [', 'deck=song ', 'at=', 'level=muted', 'fade=in');
      assert.ok(drag < press && press < play, `in order: drag ${drag}, press ${press}, play ${play}`);

      const paused = panel.waitForState((patch) => patch.playback === PlaybackState.PAUSED, 8000);
      panel.write('playback', PlaybackState.PAUSED);
      await paused;
      find('the pause', '] Pause [', 'deck=song ', 'fade=out');
    } finally {
      console.log = print;
      if (panel.socket?.connected) {
        const unmuted = panel.waitForState((patch) => patch.mute !== undefined);
        panel.write('mute', MuteState.UNMUTED);
        await unmuted.catch(() => {});
      }
      panel.disconnect();
    }
  });
});
