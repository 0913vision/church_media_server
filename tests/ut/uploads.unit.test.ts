import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Note(yoochan.kim): Uploads logs, and the logger validates LOG_LEVEL at module load.
type UploadsCtor = typeof import('../../server/tracks/Uploads.ts').default;
let Uploads: UploadsCtor;

before(async () => {
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';
  Uploads = (await import('../../server/tracks/Uploads.ts')).default;
});

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-uploads-'));
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

let written = 0;
function waitingFile(): string {
  const file = path.join(DIR, `.incoming-${written++}.part`);
  fs.writeFileSync(file, 'audio');
  return file;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('An upload waits for addTrack, and not forever', () => {
  test('claimed in time, it is handed over once and its file is left alone', async () => {
    const uploads = new Uploads(50);
    const file = waitingFile();
    const id = uploads.hold(file, 1.1);

    assert.deepStrictEqual(uploads.take(id), { file, durationSec: 1.1 });
    assert.strictEqual(uploads.take(id), undefined, 'once');
    await pause(100);
    assert.ok(fs.existsSync(file), 'the file is the claimer\'s now');
  });

  test('unclaimed, it is deleted when its time runs out', async () => {
    const uploads = new Uploads(50);
    const file = waitingFile();
    const id = uploads.hold(file, 1.1);

    await pause(100);
    assert.strictEqual(uploads.take(id), undefined);
    assert.strictEqual(fs.existsSync(file), false);
  });
});
