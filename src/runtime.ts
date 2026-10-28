import { z } from 'zod';
import { StubThreadsClient } from './clients/stub-threads-client.js';
import { QueueService } from './core/queue-service.js';
import { VercelBlobImageHost } from './images/vercel-blob-image-host.js';
import { SqliteQueueStore } from './stores/sqlite-queue-store.js';

/** Composition root only: business rules never read env or select providers themselves. */
export function createRuntime(env: NodeJS.ProcessEnv = process.env) {
  const mode = z.enum(['success', 'fail']).parse(env.THREADS_STUB_MODE ?? 'success');
  const store = new SqliteQueueStore(env.FINPLAYER_DB_PATH ?? './data/finplayer.sqlite');
  const service = new QueueService({
    store,
    client: new StubThreadsClient({ mode }),
    imageHost: new VercelBlobImageHost(env.BLOB_READ_WRITE_TOKEN),
  });
  return { service, store };
}
