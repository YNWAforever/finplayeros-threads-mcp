import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { del, put } from '@vercel/blob';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StubThreadsClient } from '../src/clients/stub-threads-client.js';
import { QueueService } from '../src/core/queue-service.js';
import { VercelBlobImageHost } from '../src/images/vercel-blob-image-host.js';
import { InMemoryQueueStore } from '../src/stores/in-memory-queue-store.js';

vi.mock('@vercel/blob', () => ({ put: vi.fn(), del: vi.fn() }));

const publicUrl = 'https://blob.example.invalid/finplayer/image.png';
const mockToken = 'mock-only-placeholder';
const blobResult = {
  url: publicUrl, downloadUrl: publicUrl, pathname: 'finplayer/image.png',
  contentType: 'image/png', contentDisposition: 'inline; filename="image.png"',
  etag: 'mock-etag',
};

describe('VercelBlobImageHost with mocked official SDK', () => {
  let directory: string;
  let imagePath: string;

  beforeEach(async () => {
    vi.resetAllMocks();
    const root = join(process.cwd(), '.test-data');
    await mkdir(root, { recursive: true });
    directory = await mkdtemp(join(root, 'blob-'));
    imagePath = join(directory, 'image.png');
    await writeFile(imagePath, new Uint8Array([137, 80, 78, 71]));
    vi.mocked(put).mockResolvedValue(blobResult);
    vi.mocked(del).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('uploads a local image as public with random naming and returns a deletion handle', async () => {
    const host = new VercelBlobImageHost(mockToken);
    expect(await host.upload(imagePath, 'image/png')).toEqual({ publicUrl, deleteHandle: publicUrl });
    expect(put).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/^finplayer\/[a-f0-9-]+\.png$/),
      expect.any(Uint8Array),
      { access: 'public', addRandomSuffix: true, contentType: 'image/png', token: mockToken },
    );
    await host.delete(publicUrl);
    expect(del).toHaveBeenCalledExactlyOnceWith(publicUrl, { token: mockToken });
  });

  it('accepts a byte buffer without a filesystem read', async () => {
    const host = new VercelBlobImageHost(mockToken);
    const bytes = new Uint8Array([1, 2, 3]);
    expect((await host.upload(bytes, 'image/jpeg')).publicUrl).toBe(publicUrl);
    expect(put).toHaveBeenCalledWith(expect.stringMatching(/\.jpg$/), Buffer.from([1, 2, 3]), expect.objectContaining({ contentType: 'image/jpeg' }));
  });

  it('rejects missing token before reading a file and makes deletion a no-op', async () => {
    const host = new VercelBlobImageHost();
    await expect(host.upload(join(directory, 'missing.png'), 'image/png')).rejects.toThrow(/not configured.*BLOB_READ_WRITE_TOKEN/);
    await expect(host.delete(publicUrl)).resolves.toBeUndefined();
    expect(put).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('rejects a non-HTTPS result from the provider', async () => {
    vi.mocked(put).mockResolvedValue({ ...blobResult, url: 'http://example.invalid/image.png' });
    await expect(new VercelBlobImageHost(mockToken).upload(imagePath, 'image/png')).rejects.toThrow(/HTTPS/);
  });

  it('does not expose provider exception details that might contain credentials', async () => {
    vi.mocked(put).mockRejectedValue(new Error(`mock provider error with ${mockToken}`));
    const host = new VercelBlobImageHost(mockToken);
    await expect(host.upload(imagePath, 'image/png')).rejects.toThrow(/^Vercel Blob upload failed\./);
    await expect(host.upload(imagePath, 'image/png')).rejects.not.toThrow(mockToken);
  });

  it('publishes with the hosted URL and deletes the image after saving media proof', async () => {
    const store = new InMemoryQueueStore();
    const client = new StubThreadsClient();
    const create = vi.spyOn(client, 'createContainer');
    const service = new QueueService({ store, client, imageHost: new VercelBlobImageHost(mockToken) });
    const post = await service.createDraft({ text: '有圖😀', image_ref: imagePath });
    await service.approveDraft(post.id);
    vi.mocked(del).mockImplementation(async () => {
      expect(await store.get(post.id)).toMatchObject({ state: 'published', threads_media_id: 'stub-media-000001' });
    });
    const published = await service.publishNow(post.id);
    expect(published.state).toBe('published');
    expect(create).toHaveBeenCalledExactlyOnceWith({ text: '有圖😀', image_url: publicUrl });
    expect(del).toHaveBeenCalledExactlyOnceWith(publicUrl, { token: mockToken });
  });

  it('keeps published state and proof if delete-after-publish fails', async () => {
    vi.mocked(del).mockRejectedValue(new Error('mock deletion failed'));
    const store = new InMemoryQueueStore();
    const service = new QueueService({ store, client: new StubThreadsClient(), imageHost: new VercelBlobImageHost(mockToken) });
    const post = await service.createDraft({ text: '有圖', image_ref: imagePath });
    await service.approveDraft(post.id);
    const published = await service.publishNow(post.id);
    expect(published).toMatchObject({ state: 'published', threads_media_id: 'stub-media-000001', image_cleanup_error: expect.any(String) });
    expect(await store.get(post.id)).toMatchObject({ state: 'published', threads_media_id: 'stub-media-000001' });
    await expect(service.publishNow(post.id)).rejects.toThrow(/post is published/);
  });

  it('keeps the image if publishing fails so deletion never precedes media proof', async () => {
    const service = new QueueService({
      store: new InMemoryQueueStore(), client: new StubThreadsClient({ mode: 'fail' }),
      imageHost: new VercelBlobImageHost(mockToken),
    });
    const post = await service.createDraft({ text: 'image', image_ref: imagePath });
    await service.approveDraft(post.id);
    expect((await service.publishNow(post.id)).state).toBe('failed');
    expect(del).not.toHaveBeenCalled();
  });
});
