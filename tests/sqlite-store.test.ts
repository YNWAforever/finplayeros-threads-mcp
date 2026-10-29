import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StubThreadsClient } from '../src/clients/stub-threads-client.js';
import { QueueService } from '../src/core/queue-service.js';
import { SqliteQueueStore } from '../src/stores/sqlite-queue-store.js';

describe('SqliteQueueStore', () => {
  let directory: string;
  let path: string;
  let stores: SqliteQueueStore[];

  function open() {
    const store = new SqliteQueueStore(path);
    stores.push(store);
    return store;
  }

  beforeEach(async () => {
    const root = join(process.cwd(), '.test-data');
    await mkdir(root, { recursive: true });
    directory = await mkdtemp(join(root, 'sqlite-'));
    path = join(directory, 'nested', 'finplayer.sqlite');
    stores = [];
  });

  afterEach(async () => {
    for (const store of stores) store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('starts empty and persists content, approval, schedule and proof across reopen', async () => {
    const store = open();
    expect(await store.list()).toEqual([]);
    const service = new QueueService({ store, client: new StubThreadsClient() });
    const draft = await service.createDraft({ text: '持久保存😀', link: 'https://example.invalid/story', source_note: '筆記' });
    await service.approveDraft(draft.id, 'Willy');
    await service.schedulePost(draft.id, '2999-10-30T09:00');
    const published = await service.publishNow(draft.id);
    store.close();
    expect(await open().get(draft.id)).toEqual(published);
    const header = (await readFile(path)).subarray(0, 16).toString();
    expect(header).toBe('SQLite format 3\0');
  });

  it('rejects an empty database path rather than creating an anonymous temporary database', () => {
    expect(() => new SqliteQueueStore('')).toThrow(/path.*empty/);
  });

  it('upserts atomically without duplicate rows and preserves independent concurrent saves', async () => {
    const store = open();
    const service = new QueueService({ store, client: new StubThreadsClient() });
    const posts = await Promise.all(Array.from({ length: 10 }, () => service.createDraft({ text: 'test' })));
    await Promise.all(posts.map((post) => store.save({ ...post, text: 'updated' })));
    expect(await store.list()).toHaveLength(10);
    expect((await store.list()).every((post) => post.text === 'updated')).toBe(true);
  });

  it('rejects invalid approval records without overwriting the valid row', async () => {
    const store = open();
    const service = new QueueService({ store, client: new StubThreadsClient() });
    const draft = await service.createDraft({ text: 'test' });
    await expect(store.save({ ...draft, state: 'failed' })).rejects.toThrow(/approved_at/);
    expect(await store.get(draft.id)).toEqual(draft);
    expect(await store.get('missing')).toBeUndefined();
  });

  it('keeps approval reset and failed retry history through SQLite persistence', async () => {
    const store = open();
    const client = new StubThreadsClient({ mode: 'fail' });
    const service = new QueueService({ store, client });
    const draft = await service.createDraft({ text: 'original' });
    await service.approveDraft(draft.id, 'Willy');
    await service.updateDraft(draft.id, { text: 'edited' });
    expect(await store.get(draft.id)).toMatchObject({ state: 'draft', text: 'edited' });
    expect((await store.get(draft.id))?.approved_at).toBeUndefined();
    await service.approveDraft(draft.id, 'Willy again');
    await service.publishNow(draft.id);
    client.setMode('success');
    await service.publishNow(draft.id);
    store.close();
    const persisted = await open().get(draft.id);
    expect(persisted).toMatchObject({ state: 'published', approved_by: 'Willy again' });
    expect(persisted?.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'approved', to: 'draft' }),
      expect.objectContaining({ from: 'failed', to: 'approved', reason: 'retry' }),
    ]));
  });
});
