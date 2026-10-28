import { describe, expect, it, vi } from 'vitest';
import { StubThreadsClient } from '../src/clients/stub-threads-client.js';
import { QueueService } from '../src/core/queue-service.js';
import { ScheduledExecutor } from '../src/scheduler/executor.js';
import { refreshThreadsToken } from '../src/scheduler/token-refresh.js';
import { InMemoryQueueStore } from '../src/stores/in-memory-queue-store.js';

function setup(client = new StubThreadsClient()) {
  const service = new QueueService({
    store: new InMemoryQueueStore(), client, now: () => new Date('2026-10-29T00:00:00Z'),
  });
  const executor = new ScheduledExecutor(service);
  const schedule = async (publishAt: string) => {
    const post = await service.createDraft({ text: 'scheduled😀' });
    await service.approveDraft(post.id, 'Willy');
    return service.schedulePost(post.id, publishAt);
  };
  return { service, client, executor, schedule };
}

describe('runDueScheduled', () => {
  it('publishes only due scheduled posts with the same gated publish path', async () => {
    const { service, client, executor, schedule } = setup();
    const create = vi.spyOn(client, 'createContainer');
    const due = await schedule('2026-10-30T09:00');
    const later = await schedule('2026-10-31T09:00');
    const draft = await service.createDraft({ text: 'unapproved' });
    const approved = await service.createDraft({ text: 'unscheduled' });
    await service.approveDraft(approved.id);
    expect(create).not.toHaveBeenCalled();
    const results = await executor.runDueScheduled(new Date('2026-10-30T01:00:00Z'));
    expect(results).toMatchObject([{ id: due.id, state: 'published', threads_media_id: 'stub-media-000001' }]);
    expect(create).toHaveBeenCalledTimes(1);
    expect((await service.listQueue('scheduled')).map((post) => post.id)).toEqual([later.id]);
    expect((await service.listQueue('draft')).map((post) => post.id)).toEqual([draft.id]);
    expect((await service.listQueue('approved')).map((post) => post.id)).toEqual([approved.id]);
    expect(await executor.runDueScheduled(new Date('2026-10-30T01:00:00Z'))).toEqual([]);
  });

  it('records failure, continues with other due posts, and does not implicitly retry failed posts', async () => {
    const { service, client, executor, schedule } = setup();
    await schedule('2026-10-30T09:00');
    await schedule('2026-10-30T09:00');
    vi.spyOn(client, 'createContainer').mockRejectedValueOnce(new Error('first failed'));
    const results = await executor.runDueScheduled(new Date('2026-10-30T01:00:00Z'));
    expect(results.map((post) => post.state)).toEqual(['failed', 'published']);
    expect((await service.listQueue('failed'))[0]?.last_error).toBe('first failed');
    expect(await executor.runDueScheduled(new Date('2026-11-01T00:00:00Z'))).toEqual([]);
  });

  it('rechecks due status under the service lock after cancellation or rescheduling', async () => {
    const { service, executor, schedule } = setup();
    const post = await schedule('2026-10-30T09:00');
    const list = service.listQueue.bind(service);
    vi.spyOn(service, 'listQueue').mockImplementationOnce(async (state) => {
      const snapshot = await list(state);
      await service.cancelScheduled(post.id);
      await service.schedulePost(post.id, '2026-11-01T09:00');
      return snapshot;
    });
    expect(await executor.runDueScheduled(new Date('2026-10-30T01:00:00Z'))).toEqual([]);
    expect((await list())[0]?.state).toBe('scheduled');
  });

  it('overlapping executor runs do not publish the same post twice', async () => {
    const { client, executor, schedule } = setup();
    const publish = vi.spyOn(client, 'publishContainer');
    await schedule('2026-10-30T09:00');
    const now = new Date('2026-10-30T01:00:00Z');
    const results = await Promise.all([executor.runDueScheduled(now), executor.runDueScheduled(now)]);
    expect(results.flat()).toHaveLength(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

it('weekly token refresh is a not-configured stub and never performs HTTP', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  try {
    expect(await refreshThreadsToken()).toMatchObject({ status: 'not-configured', message: expect.stringContaining('Task 1c') });
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});
