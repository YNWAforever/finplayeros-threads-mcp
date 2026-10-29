import { randomUUID } from 'node:crypto';
import type { ThreadsClient } from '../clients/threads-client.js';
import { NotConfiguredImageHost, type HostedImage, type ImageHostAdapter } from '../images/image-host.js';
import type { QueueStore } from '../stores/queue-store.js';
import {
  createDraftSchema, updateDraftSchema, type CreateDraftInput,
  type UpdateDraftInput, type QueuePost, type PostState,
} from './model.js';
import { parsePublishAt, validateThreadsText } from './validation.js';

export interface QueueServiceOptions {
  store: QueueStore;
  client: ThreadsClient;
  imageHost?: ImageHostAdapter;
  now?: () => Date;
  newId?: () => string;
  wait?: (milliseconds: number) => Promise<void>;
}

/** Business rules have no env, filesystem, MCP, or HTTP dependencies. */
export class QueueService {
  private readonly store: QueueStore;
  private readonly client: ThreadsClient;
  private readonly imageHost: ImageHostAdapter;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(options: QueueServiceOptions) {
    this.store = options.store;
    this.client = options.client;
    this.imageHost = options.imageHost ?? new NotConfiguredImageHost();
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  createDraft(input: CreateDraftInput): Promise<QueuePost> {
    return this.serial(async () => {
      const fields = createDraftSchema.parse(input);
      validateThreadsText(fields.text);
      const timestamp = this.now().toISOString();
      const post: QueuePost = {
        ...fields, id: this.newId(), state: 'draft', created_at: timestamp, updated_at: timestamp,
        history: [{ from: null, to: 'draft', at: timestamp, reason: 'created' }],
      };
      await this.store.save(post);
      return post;
    });
  }

  updateDraft(id: string, input: UpdateDraftInput): Promise<QueuePost> {
    return this.serial(async () => {
      const post = await this.requirePost(id);
      this.requireState(post, ['draft', 'approved'], 'update_draft');
      const patch = updateDraftSchema.parse(input);
      if (patch.text !== undefined) post.text = patch.text;
      for (const field of ['link', 'image_ref', 'source_note'] as const) {
        if (patch[field] === null) delete post[field];
        else if (patch[field] !== undefined) post[field] = patch[field];
      }
      validateThreadsText(post.text);
      if (post.state === 'approved') {
        delete post.approved_at;
        delete post.approved_by;
      }
      this.transition(post, 'draft', 'edited');
      await this.store.save(post);
      return post;
    });
  }

  approveDraft(id: string, approvedBy?: string): Promise<QueuePost> {
    return this.serial(async () => {
      const post = await this.requirePost(id);
      this.requireState(post, ['draft'], 'approve_draft');
      this.transition(post, 'approved', 'human approval');
      post.approved_at = post.updated_at;
      if (approvedBy !== undefined) post.approved_by = approvedBy;
      await this.store.save(post);
      return post;
    });
  }

  schedulePost(id: string, publishAt: string): Promise<QueuePost> {
    return this.serial(async () => {
      const post = await this.requirePost(id);
      this.requireApproved(post, ['approved', 'failed'], 'schedule_post');
      const now = this.now();
      const normalized = parsePublishAt(publishAt, now);
      await this.reenterApproved(post);
      post.publish_at = normalized;
      this.transition(post, 'scheduled', 'scheduled');
      delete post.last_error;
      await this.store.save(post);
      return post;
    });
  }

  publishNow(id: string): Promise<QueuePost> {
    return this.serial(async () => {
      const post = await this.requirePost(id);
      this.requireApproved(post, ['approved', 'scheduled', 'failed'], 'publish_now');
      return this.publishPost(post);
    });
  }

  /** Executor-only helper: recheck scheduling under the same lock as publishing. No extra MCP tool. */
  publishDueScheduled(id: string, now: Date): Promise<QueuePost | undefined> {
    return this.serial(async () => {
      if (!Number.isFinite(now.getTime())) throw new Error('Executor now must be a valid Date.');
      const post = await this.requirePost(id);
      if (post.state !== 'scheduled' || !post.publish_at || Date.parse(post.publish_at) > now.getTime()) {
        return undefined;
      }
      this.requireApproved(post, ['scheduled'], 'publish_now');
      return this.publishPost(post);
    });
  }

  listQueue(state?: PostState): Promise<QueuePost[]> {
    return this.serial(async () => {
      const posts = await this.store.list();
      return state ? posts.filter((post) => post.state === state) : posts;
    });
  }

  cancelScheduled(id: string): Promise<QueuePost> {
    return this.serial(async () => {
      const post = await this.requirePost(id);
      this.requireState(post, ['scheduled'], 'cancel_scheduled');
      this.transition(post, 'approved', 'schedule cancelled');
      delete post.publish_at;
      await this.store.save(post);
      return post;
    });
  }

  private async publishPost(post: QueuePost): Promise<QueuePost> {
    await this.reenterApproved(post);
    let image: HostedImage | undefined;
    try {
      image = await this.prepareImage(post);
      const container = await this.client.createContainer({
        text: post.text, ...(image ? { image_url: image.publicUrl } : {}),
      });
      if (!container.id?.trim()) throw new Error('Threads returned no container ID.');
      await this.waitForContainer(container.id);
      const result = await this.client.publishContainer(container.id);
      if (!result.id?.trim()) throw new Error('Threads returned no media ID; publish is not confirmed.');
      this.transition(post, 'published', 'media ID confirmed');
      post.threads_media_id = result.id.trim();
      post.published_at = post.updated_at;
      delete post.last_error;
      delete post.image_cleanup_error;
    } catch (error) {
      this.transition(post, 'failed', 'publish failed');
      post.last_error = error instanceof Error ? error.message : String(error);
      delete post.threads_media_id;
      delete post.published_at;
    }
    // Persist media proof before cleanup: a deletion failure must never permit a duplicate retry.
    await this.store.save(post);
    if (post.state === 'published' && image) {
      try {
        await this.imageHost.delete(image.deleteHandle);
      } catch {
        post.image_cleanup_error = 'Image cleanup failed; published media is confirmed.';
        await this.store.save(post);
      }
    }
    return post;
  }

  private async prepareImage(post: QueuePost): Promise<HostedImage | undefined> {
    if (!post.image_ref) return undefined;
    const contentType = /\.png$/i.test(post.image_ref) ? 'image/png'
      : /\.jpe?g$/i.test(post.image_ref) ? 'image/jpeg' : undefined;
    if (!contentType) throw new Error('image_ref must name a local PNG or JPEG image.');
    const image = await this.imageHost.upload(post.image_ref, contentType);
    const url = new URL(image.publicUrl);
    if (url.protocol !== 'https:') throw new Error('Image host must return a public HTTPS URL.');
    return image;
  }

  private async reenterApproved(post: QueuePost): Promise<void> {
    if (post.state !== 'failed') return;
    this.transition(post, 'approved', 'retry');
    delete post.last_error;
    await this.store.save(post);
  }

  private transition(post: QueuePost, state: PostState, reason: string): void {
    const at = this.now().toISOString();
    post.history.push({ from: post.state, to: state, at, reason });
    post.state = state;
    post.updated_at = at;
  }

  private async waitForContainer(id: string): Promise<void> {
    // Check immediately, then once a minute, for at most five minutes.
    for (let attempt = 0; attempt <= 5; attempt++) {
      const result = await this.client.getContainerStatus(id);
      if (result.status === 'FINISHED') return;
      if (result.status !== 'IN_PROGRESS') {
        throw new Error(`Threads container ${result.status}: ${result.error_message ?? 'not ready to publish'}.`);
      }
      if (attempt < 5) await this.wait(60_000);
    }
    throw new Error('Threads container timed out after five minutes.');
  }

  private async requirePost(id: string): Promise<QueuePost> {
    const post = await this.store.get(id);
    if (!post) throw new Error(`Post ${id} was not found.`);
    return post;
  }

  private requireState(post: QueuePost, allowed: PostState[], tool: string): void {
    if (!allowed.includes(post.state)) {
      throw new Error(`${tool} requires state ${allowed.join(' or ')}; post is ${post.state}.`);
    }
  }

  private requireApproved(post: QueuePost, allowed: PostState[], tool: string): void {
    if (!post.approved_at) {
      throw new Error(`${tool} requires explicit human approval via approve_draft.`);
    }
    this.requireState(post, allowed, tool);
  }

  /** Also prevents two concurrent publish requests from publishing the same post twice. */
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }
}
