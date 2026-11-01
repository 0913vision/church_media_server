import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { APK_CONFIG } from '../constants/apkConfig.ts';
import { errorMessage } from '../utils/errors.ts';
import { log } from '../utils/logger.ts';

/** The file server wants its password in a POST body, so this relay lets an outdated app update by a plain link. */
export async function serveApk(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const variant = req.url === '/apk/phone' ? 'phone' : req.url === '/apk/tablet' ? 'tablet' : null;
  if (req.method !== 'GET' || variant === null) {
    res.writeHead(404).end();
    return;
  }

  try {
    const upstream = await fetch(`${APK_CONFIG.FILESERVER_URL}/download/${APK_CONFIG.FILE_IDS[variant]}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: APK_CONFIG.FILESERVER_PASSWORD })
    });
    if (!upstream.ok || upstream.body === null) {
      log.warn('apk', null, 'File server refused the download', { variant, status: upstream.status });
      res.writeHead(502).end();
      return;
    }

    const headers: Record<string, string> = {
      'content-type': upstream.headers.get('content-type') ?? 'application/vnd.android.package-archive',
      'content-disposition': upstream.headers.get('content-disposition') ?? `attachment; filename="church-music-${variant}.apk"`
    };
    const length = upstream.headers.get('content-length');
    if (length !== null) headers['content-length'] = length;

    res.writeHead(200, headers);
    Readable.fromWeb(upstream.body as WebReadableStream).pipe(res);
  } catch (error) {
    log.warn('apk', null, 'File server unreachable', { variant, error: errorMessage(error) });
    res.writeHead(502).end();
  }
}
