import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createRuntime } from '../src/runtime.js';

it('uses SQLite and a default successful Threads stub, with unconfigured Blob when no token is provided', async () => {
  const root = join(process.cwd(), '.test-data');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'runtime-'));
  const runtime = createRuntime({ FINPLAYER_DB_PATH: join(directory, 'queue.sqlite') });
  try {
    const text = await runtime.service.createDraft({ text: 'runtime' });
    await runtime.service.approveDraft(text.id);
    expect(await runtime.service.publishNow(text.id)).toMatchObject({ state: 'published', threads_media_id: 'stub-media-000001' });
    const image = await runtime.service.createDraft({ text: 'image', image_ref: './missing.png' });
    await runtime.service.approveDraft(image.id);
    expect(await runtime.service.publishNow(image.id)).toMatchObject({ state: 'failed', last_error: expect.stringContaining('BLOB_READ_WRITE_TOKEN') });
  } finally {
    runtime.store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('rejects invalid stub configuration before opening a database', () => {
  expect(() => createRuntime({ THREADS_STUB_MODE: 'invalid' })).toThrow();
});
