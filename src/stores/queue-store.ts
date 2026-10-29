import type { QueuePost } from '../core/model.js';

export interface QueueStore {
  list(): Promise<QueuePost[]>;
  get(id: string): Promise<QueuePost | undefined>;
  save(post: QueuePost): Promise<void>;
}
