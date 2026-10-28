import { describe, expect, it, vi } from 'vitest';
import { StubThreadsClient } from '../src/clients/stub-threads-client.js';
import { RealThreadsClient } from '../src/clients/real-threads-client.js';
import { dueScheduled } from '../src/core/model.js';
import { QueueService } from '../src/core/queue-service.js';
import { NotConfiguredImageHost } from '../src/images/image-host.js';
import { InMemoryQueueStore } from '../src/stores/in-memory-queue-store.js';

const now = new Date('2026-10-29T00:00:00.000Z');
const future = '2026-10-30T09:00:00';

function setup(client = new StubThreadsClient()) {
  const store = new InMemoryQueueStore();
  let counter = 0;
  const wait = vi.fn(async (_milliseconds: number) => undefined);
  const service = new QueueService({
    store, client, now: () => new Date(now), newId: () => `post-${++counter}`, wait,
  });
  const approved = async () => {
    const draft = await service.createDraft({ text: '今日同大家傾下投資😀' });
    return service.approveDraft(draft.id, 'Willy');
  };
  return { service, store, client, wait, approved };
}

describe('approval and transitions', () => {
  it('rejects unapproved schedule and publish without contacting the client', async () => {
    const { service, client } = setup();
    const create = vi.spyOn(client, 'createContainer');
    const draft = await service.createDraft({ text: '未批核' });
    await expect(service.schedulePost(draft.id, future)).rejects.toThrow(/human approval/);
    await expect(service.publishNow(draft.id)).rejects.toThrow(/human approval/);
    expect((await service.listQueue())[0]?.state).toBe('draft');
    expect(create).not.toHaveBeenCalled();
  });

  it('approves, schedules locally, then publishes through create -> status -> publish', async () => {
    const { service, client, approved } = setup();
    const create = vi.spyOn(client, 'createContainer');
    const status = vi.spyOn(client, 'getContainerStatus');
    const publish = vi.spyOn(client, 'publishContainer');
    const post = await approved();
    expect(post).toMatchObject({ state: 'approved', approved_at: now.toISOString(), approved_by: 'Willy' });
    const scheduled = await service.schedulePost(post.id, future);
    expect(scheduled).toMatchObject({ state: 'scheduled', publish_at: '2026-10-30T01:00:00.000Z' });
    expect(create).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    const result = await service.publishNow(post.id);
    expect(result).toMatchObject({
      state: 'published', threads_media_id: 'stub-media-000001', published_at: now.toISOString(),
    });
    expect(create.mock.invocationCallOrder[0]).toBeLessThan(status.mock.invocationCallOrder[0] ?? 0);
    expect(status.mock.invocationCallOrder[0]).toBeLessThan(publish.mock.invocationCallOrder[0] ?? 0);
  });

  it('publishes directly from approved without scheduling', async () => {
    const { service, approved } = setup();
    const post = await approved();
    expect(await service.publishNow(post.id)).toMatchObject({ state: 'published', threads_media_id: expect.any(String) });
  });

  it('records any stub failure and permits publish retry while preserving approval', async () => {
    const { service, client, approved } = setup(new StubThreadsClient({ mode: 'fail' }));
    const post = await approved();
    const failed = await service.publishNow(post.id);
    expect(failed).toMatchObject({ state: 'failed', last_error: 'Stub Threads failure at create.', approved_by: 'Willy' });
    expect(failed.threads_media_id).toBeUndefined();
    client.setMode('success');
    const retried = await service.publishNow(post.id);
    expect(retried).toMatchObject({ state: 'published', approved_at: post.approved_at });
    expect(retried.last_error).toBeUndefined();
  });

  it('allows scheduling a failed, previously approved post again', async () => {
    const { service, client, approved } = setup(new StubThreadsClient({ mode: 'fail' }));
    const post = await approved();
    await service.publishNow(post.id);
    expect(await service.schedulePost(post.id, future)).toMatchObject({ state: 'scheduled', approved_at: post.approved_at });
    client.setMode('success');
    expect((await service.publishNow(post.id)).state).toBe('published');
  });

  it('list_queue exposes all five states, proof, timestamps, error, and filtering', async () => {
    const { service, approved, client } = setup();
    await service.createDraft({ text: 'draft' });
    await approved();
    const scheduled = await approved();
    await service.schedulePost(scheduled.id, future);
    const published = await approved();
    await service.publishNow(published.id);
    const failed = await approved();
    client.setMode('fail');
    await service.publishNow(failed.id);
    const posts = await service.listQueue();
    expect(posts.map((post) => post.state)).toEqual(['draft', 'approved', 'scheduled', 'published', 'failed']);
    expect(posts.every((post) => post.created_at && post.updated_at)).toBe(true);
    expect(posts[2]?.publish_at).toBeDefined();
    expect(posts[3]?.threads_media_id).toBeDefined();
    expect(posts[4]?.last_error).toBeDefined();
    expect((await service.listQueue('failed')).map((post) => post.id)).toEqual([failed.id]);
  });

  it('cancels scheduled posts back to approved and clears publish_at', async () => {
    const { service, approved } = setup();
    const post = await approved();
    await service.schedulePost(post.id, future);
    const cancelled = await service.cancelScheduled(post.id);
    expect(cancelled.state).toBe('approved');
    expect(cancelled.publish_at).toBeUndefined();
    expect(cancelled.approved_at).toBe(post.approved_at);
  });

  it.each(['draft', 'approved', 'published', 'failed'] as const)('rejects cancel_scheduled from %s', async (state) => {
    const { service, client } = setup();
    const post = await service.createDraft({ text: 'test' });
    if (state !== 'draft') await service.approveDraft(post.id);
    if (state === 'failed') client.setMode('fail');
    if (state === 'published' || state === 'failed') await service.publishNow(post.id);
    await expect(service.cancelScheduled(post.id)).rejects.toThrow(/cancel_scheduled requires state scheduled/);
  });

  it('updates draft content and allows clearing image references', async () => {
    const { service } = setup();
    const post = await service.createDraft({ text: '舊文', image_ref: './screenshot.png' });
    expect(await service.updateDraft(post.id, { text: '新文', image_ref: null })).toMatchObject({ text: '新文', state: 'draft' });
    expect((await service.listQueue())[0]?.image_ref).toBeUndefined();
  });

  it.each(['scheduled', 'published', 'failed'] as const)('rejects editing from %s', async (state) => {
    const { service, approved, client } = setup();
    const post = await approved();
    if (state === 'scheduled') await service.schedulePost(post.id, future);
    if (state === 'failed') client.setMode('fail');
    if (state === 'published' || state === 'failed') await service.publishNow(post.id);
    await expect(service.updateDraft(post.id, { text: 'changed' })).rejects.toThrow(/update_draft requires state draft/);
    expect((await service.listQueue())[0]?.text).toBe(post.text);
    await expect(service.approveDraft(post.id)).rejects.toThrow(/approve_draft requires state draft/);
  });

  it('retains link, image_ref and source_note as local draft metadata', async () => {
    const { service } = setup();
    const post = await service.createDraft({
      text: '靈感', link: 'https://example.invalid/story', image_ref: './image.png', source_note: '口述筆記',
    });
    expect((await service.listQueue())[0]).toMatchObject({
      id: post.id, link: 'https://example.invalid/story', image_ref: './image.png', source_note: '口述筆記',
    });
  });

  it.each([
    { text: '修改內容' }, { link: 'https://example.invalid/new' },
    { image_ref: './new.png' }, { source_note: '修改筆記' },
  ])('editing any approved draft field clears approval and requires reapproval: %j', async (patch) => {
    const { service, approved } = setup();
    const post = await approved();
    const edited = await service.updateDraft(post.id, patch);
    expect(edited.state).toBe('draft');
    expect(edited.approved_at).toBeUndefined();
    expect(edited.approved_by).toBeUndefined();
    await expect(service.publishNow(post.id)).rejects.toThrow(/human approval/);
    await expect(service.schedulePost(post.id, future)).rejects.toThrow(/human approval/);
    expect((await service.approveDraft(post.id, 'Willy again')).state).toBe('approved');
  });

  it('invalid edits preserve the previously approved content and approval', async () => {
    const { service, approved } = setup();
    const post = await approved();
    await expect(service.updateDraft(post.id, { text: '😀'.repeat(126) })).rejects.toThrow(/504.*500/);
    expect((await service.listQueue())[0]).toMatchObject({ text: post.text, state: 'approved', approved_at: post.approved_at });
  });

  it.each(['publish', 'schedule'] as const)('records failed -> approved before a %s retry', async (operation) => {
    const { service, store, client, approved } = setup(new StubThreadsClient({ mode: 'fail' }));
    const post = await approved();
    await service.publishNow(post.id);
    const states: string[] = [];
    const save = store.save.bind(store);
    vi.spyOn(store, 'save').mockImplementation(async (item) => { states.push(item.state); await save(item); });
    client.setMode('success');
    const result = operation === 'publish'
      ? await service.publishNow(post.id) : await service.schedulePost(post.id, future);
    expect(states).toEqual(['approved', operation === 'publish' ? 'published' : 'scheduled']);
    expect(result.history).toContainEqual({ from: 'failed', to: 'approved', at: now.toISOString(), reason: 'retry' });
    expect(result.approved_at).toBe(post.approved_at);
    expect(result.approved_by).toBe('Willy');
  });

  it('rejects oversized creates and updates without altering stored content', async () => {
    const { service } = setup();
    await expect(service.createDraft({ text: '😀'.repeat(126) })).rejects.toThrow(/504.*500/);
    const post = await service.createDraft({ text: '廣'.repeat(500) });
    await expect(service.updateDraft(post.id, { text: '廣'.repeat(501) })).rejects.toThrow(/501.*500/);
    expect((await service.listQueue())[0]?.text).toBe(post.text);
  });

  it('rejects past schedules without changing approval state', async () => {
    const { service, approved } = setup();
    const post = await approved();
    await expect(service.schedulePost(post.id, '2026-10-28T09:00:00')).rejects.toThrow(/past/);
    expect((await service.listQueue())[0]?.state).toBe('approved');
  });

  it('dueScheduled is a pure selector with no automatic publication', async () => {
    const { service, approved } = setup();
    const post = await approved();
    await service.schedulePost(post.id, future);
    const posts = await service.listQueue();
    expect(dueScheduled(posts, now)).toEqual([]);
    expect(dueScheduled(posts, new Date('2026-10-30T01:00:00Z')).map((item) => item.id)).toEqual([post.id]);
    expect((await service.listQueue())[0]?.state).toBe('scheduled');
  });

  it('serializes simultaneous publish calls so only one publishes', async () => {
    const { service, client, approved } = setup();
    const publish = vi.spyOn(client, 'publishContainer');
    const post = await approved();
    const results = await Promise.allSettled([service.publishNow(post.id), service.publishNow(post.id)]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('rejects reschedule and republish of published posts', async () => {
    const { service, approved } = setup();
    const post = await approved();
    await service.publishNow(post.id);
    await expect(service.schedulePost(post.id, future)).rejects.toThrow(/post is published/);
    await expect(service.publishNow(post.id)).rejects.toThrow(/post is published/);
  });

  it('rejects nonexistent IDs', async () => {
    const { service } = setup();
    await expect(service.publishNow('missing')).rejects.toThrow(/not found/);
  });

  it('requires recorded approval even if a custom store returns a forged failed state', async () => {
    const { service, store } = setup();
    const draft = await service.createDraft({ text: 'test' });
    vi.spyOn(store, 'get').mockResolvedValue({ ...draft, state: 'failed' });
    await expect(service.publishNow(draft.id)).rejects.toThrow(/human approval/);
    await expect(service.schedulePost(draft.id, future)).rejects.toThrow(/human approval/);
  });

  it('returns detached objects so mutating a response cannot bypass approval', async () => {
    const { service } = setup();
    const post = await service.createDraft({ text: 'test' });
    post.state = 'approved';
    post.approved_at = now.toISOString();
    await expect(service.publishNow(post.id)).rejects.toThrow(/human approval/);
  });
});

describe('publish errors and container polling', () => {
  it.each(['create', 'status', 'publish'] as const)('marks thrown %s failures as failed', async (failAt) => {
    const { service, approved } = setup(new StubThreadsClient({ mode: 'fail', failAt }));
    const post = await approved();
    const result = await service.publishNow(post.id);
    expect(result).toMatchObject({ state: 'failed', last_error: expect.stringContaining(failAt) });
    expect(result.threads_media_id).toBeUndefined();
  });

  it.each(['ERROR', 'EXPIRED', 'PUBLISHED'] as const)('fails closed on container status %s', async (status) => {
    const { service, client, approved } = setup(new StubThreadsClient({ statuses: [{ status, error_message: 'not usable' }] }));
    const publish = vi.spyOn(client, 'publishContainer');
    const post = await approved();
    expect(await service.publishNow(post.id)).toMatchObject({ state: 'failed', last_error: expect.stringContaining(status) });
    expect(publish).not.toHaveBeenCalled();
  });

  it('checks IN_PROGRESS once per minute until FINISHED', async () => {
    const { service, wait, approved } = setup(new StubThreadsClient({
      statuses: [{ status: 'IN_PROGRESS' }, { status: 'FINISHED' }],
    }));
    const post = await approved();
    expect((await service.publishNow(post.id)).state).toBe('published');
    expect(wait).toHaveBeenCalledExactlyOnceWith(60_000);
  });

  it('bounds polling at five minutes and never publishes an unfinished container', async () => {
    const { service, client, wait, approved } = setup(new StubThreadsClient({ statuses: [{ status: 'IN_PROGRESS' }] }));
    const status = vi.spyOn(client, 'getContainerStatus');
    const publish = vi.spyOn(client, 'publishContainer');
    const post = await approved();
    expect(await service.publishNow(post.id)).toMatchObject({ state: 'failed', last_error: expect.stringContaining('timed out') });
    expect(status).toHaveBeenCalledTimes(6);
    expect(wait).toHaveBeenCalledTimes(5);
    expect(publish).not.toHaveBeenCalled();
  });

  it.each(['', '   '])('never marks published without a nonblank media ID (%j)', async (id) => {
    const { service, client, approved } = setup();
    vi.spyOn(client, 'publishContainer').mockResolvedValue({ id });
    const post = await approved();
    expect(await service.publishNow(post.id)).toMatchObject({ state: 'failed', last_error: expect.stringContaining('no media ID') });
  });

  it('fails cleanly if container ID is missing', async () => {
    const { service, client, approved } = setup();
    vi.spyOn(client, 'createContainer').mockResolvedValue({ id: '' });
    const post = await approved();
    expect(await service.publishNow(post.id)).toMatchObject({ state: 'failed', last_error: expect.stringContaining('no container ID') });
  });

  it('handles non-Error throws as failures too', async () => {
    const { service, client, approved } = setup();
    vi.spyOn(client, 'createContainer').mockRejectedValue('stub rejection');
    const post = await approved();
    expect(await service.publishNow(post.id)).toMatchObject({ state: 'failed', last_error: 'stub rejection' });
  });

  it.each([{ image_ref: './image.png' }, { image_ref: './image.jpg' }])('fails image publishing without a configured host: %j', async (image) => {
    const { service, client } = setup();
    const create = vi.spyOn(client, 'createContainer');
    const post = await service.createDraft({ text: '有圖', ...image });
    await service.approveDraft(post.id);
    expect(await service.publishNow(post.id)).toMatchObject({ state: 'failed', last_error: expect.stringContaining('Image host not configured') });
    expect(create).not.toHaveBeenCalled();
  });

  it('has only throwing placeholders for the real client and image provider', async () => {
    const client = new RealThreadsClient();
    await expect(client.createContainer({ text: 'test' })).rejects.toThrow('not configured — awaiting Meta app + OAuth (Task 1c)');
    await expect(client.getContainerStatus('container')).rejects.toThrow(/Task 1c/);
    await expect(client.publishContainer('container')).rejects.toThrow(/Task 1c/);
    const host = new NotConfiguredImageHost();
    await expect(host.upload(new Uint8Array(), 'image/png')).rejects.toThrow(/not configured/);
    await expect(host.delete('handle')).resolves.toBeUndefined();
  });
});
