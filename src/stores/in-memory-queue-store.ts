import { queuePostSchema, type QueuePost } from '../core/model.js';
import type { QueueStore } from './queue-store.js';

export class InMemoryQueueStore implements QueueStore {
  private readonly posts = new Map<string, QueuePost>();

  async list(): Promise<QueuePost[]> {
    return structuredClone([...this.posts.values()]);
  }

  async get(id: string): Promise<QueuePost | undefined> {
    const post = this.posts.get(id);
    return post ? structuredClone(post) : undefined;
  }

  async save(post: QueuePost): Promise<void> {
    const validated = queuePostSchema.parse(post);
    this.posts.set(validated.id, structuredClone(validated));
  }
}
