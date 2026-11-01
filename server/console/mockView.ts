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

/** Every address, worked out fresh: a LAN and a VPN look alike from here, and a laptop moves between networks. */
function serverAddresses(): string[] {
  const found = Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry !== undefined && entry.family === 'IPv4' && !entry.internal)
    // Note(yoochan.kim): written as the app's address box wants it, so it can be typed straight in.
    .map((entry) => `http://${entry!.address}:${SOCKET_CONFIG.PORT}/`);
  return found.length > 0 ? found : [`http://localhost:${SOCKET_CONFIG.PORT}/`];
}

/** Mock only, as a page moving real masters must not exist; lets a run be watched in silence. True if it handled it. */
export function createMockView(mock: MockConsole): (req: IncomingMessage, res: ServerResponse) => boolean {
  // Note(yoochan.kim): one console listener for every page, since a listener list cannot take one back per tab.
  const watching = new Set<ServerResponse>();
  mock.onChange(() => {
    if (watching.size === 0) return;
    const frame = `data: ${JSON.stringify(mock.snapshot())}\n\n`;
    for (const watcher of watching) watcher.write(frame);
  });

  const whereFrame = (): string => `event: where\ndata: ${JSON.stringify(serverAddresses())}\n\n`;
  // Note(yoochan.kim): its own beat, since a new network moves it; unref'd so it alone never keeps the process alive.
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
      // Note(yoochan.kim): the current state first, so a just-opened page is not blank until something moves.
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
