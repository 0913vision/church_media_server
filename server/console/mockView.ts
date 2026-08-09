import os from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SOCKET_CONFIG } from '../constants/socketConfig.ts';
import type MockConsole from './MockConsole.ts';
import { mockPage } from './mockPage.ts';
import { log } from '../utils/logger.ts';

/** A hand on a desk sends one small object; anything larger is not one. */
const MAX_BODY_BYTES = 1024;

/** How often the page is told where this server is. */
const WHERE_MS = 3000;

/**
 * Where a panel would reach the server this desk belongs to.
 *
 * Note(yoochan.kim): a mock desk exists only because a media server is running
 * in mock mode, so opening this page is already knowing where that server is —
 * but only if the page says so. Written the way the app's own address box wants
 * it, so it can be read off the screen and typed straight in.
 *
 * Every address this machine answers on is listed. Which one a panel can reach
 * is not something this end can know: a laptop is usually on a LAN and a VPN at
 * once, and the two look identical from here. And a laptop moves between
 * networks, so this is worked out fresh rather than remembered.
 */
function serverAddresses(): string[] {
  const found = Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry !== undefined && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => `http://${entry!.address}:${SOCKET_CONFIG.PORT}/`);
  return found.length > 0 ? found : [`http://localhost:${SOCKET_CONFIG.PORT}/`];
}

/**
 * A face for the mock desk, at `/mock`.
 *
 * The desk this server drives is the one thing about it nobody can watch: the
 * X32 answers only two of the addresses it is sent, so a mute group released or
 * a master moved leaves no trace anywhere — and checking on the real desk means
 * a room full of people hearing the check. This draws the mock's own state
 * instead, along with every message it was sent, in order and with the pauses
 * between them, so a sequence can be watched through in silence.
 *
 * It exists only when the console is the mock. Handed a real desk there is
 * nothing here to draw, and a page that could move the masters had better not
 * be reachable when the masters are real.
 *
 * Returns whether it took the request, so the caller can go on to its own routes.
 */
export function createMockView(mock: MockConsole): (req: IncomingMessage, res: ServerResponse) => boolean {
  // Note(yoochan.kim): one listener on the console, many watchers on the page.
  // Subscribing per connection would grow the console a listener for every tab
  // ever opened, since a listener list has no way to take one back.
  const watching = new Set<ServerResponse>();
  mock.onChange(() => {
    if (watching.size === 0) return;
    const frame = `data: ${JSON.stringify(mock.snapshot())}\n\n`;
    for (const watcher of watching) watcher.write(frame);
  });

  const whereFrame = (): string => `event: where\ndata: ${JSON.stringify(serverAddresses())}\n\n`;
  // Note(yoochan.kim): the address is the one thing here that changes without
  // the desk changing — joining another network moves it — so it is sent on its
  // own beat rather than waiting for somebody to touch a fader. Unref'd: a page
  // nobody has open must not be a reason for this process to stay alive.
  setInterval(() => {
    if (watching.size === 0) return;
    const frame = whereFrame();
    for (const watcher of watching) watcher.write(frame);
  }, WHERE_MS).unref();

  return (req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/mock' && !path!.startsWith('/mock/')) return false;

    if (req.method === 'GET' && path === '/mock') {
      const page = mockPage(mock.snapshot());
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page);
      return true;
    }

    if (req.method === 'GET' && path === '/mock/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      // Note(yoochan.kim): the current state first, so a page that has just
      // opened is not blank until somebody moves something.
      res.write(`data: ${JSON.stringify(mock.snapshot())}\n\n`);
      res.write(whereFrame());
      watching.add(res);
      req.on('close', () => watching.delete(res));
      return true;
    }

    if (req.method === 'POST' && path === '/mock/clear') {
      mock.clearJournal();
      res.writeHead(204).end();
      return true;
    }

    if (req.method === 'POST' && path === '/mock/set') {
      void readBody(req).then((body) => {
        const address = typeof body?.address === 'string' ? body.address : null;
        const value = typeof body?.value === 'number' ? body.value : null;
        if (address === null || value === null || !mock.set(address, value)) {
          log.warn('mockView', null, 'Refused a change to the mock desk', { address, value });
          res.writeHead(400).end();
          return;
        }
        res.writeHead(204).end();
      });
      return true;
    }

    res.writeHead(404).end();
    return true;
  };
}

/** The request's JSON, or null if it is not any. Bounded, because nothing here needs to be big. */
async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > MAX_BODY_BYTES) return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
