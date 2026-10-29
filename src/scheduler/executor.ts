import { dueScheduled, type QueuePost } from '../core/model.js';
import type { QueueService } from '../core/queue-service.js';

/** Called by an external cron integration; constructing this starts no timer. */
export class ScheduledExecutor {
  constructor(private readonly service: QueueService) {}

  async runDueScheduled(now: Date): Promise<QueuePost[]> {
    if (!Number.isFinite(now.getTime())) throw new Error('Executor now must be a valid Date.');
    const posts = dueScheduled(await this.service.listQueue('scheduled'), now)
      .sort((a, b) => Date.parse(a.publish_at ?? '') - Date.parse(b.publish_at ?? ''));
    const results: QueuePost[] = [];
    for (const post of posts) {
      const result = await this.service.publishDueScheduled(post.id, now);
      if (result) results.push(result);
    }
    return results;
  }
}
