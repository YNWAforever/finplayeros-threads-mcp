import { FastMCP, type ContentResult } from 'fastmcp';
import { z } from 'zod';
import { createDraftSchema, postStateSchema, updateDraftSchema, type QueuePost } from './core/model.js';
import type { QueueService } from './core/queue-service.js';

const idSchema = z.string().min(1).describe('Local queue post ID returned by create_draft.');

async function runTool(operation: () => Promise<QueuePost | QueuePost[]>): Promise<ContentResult> {
  try {
    const result = await operation();
    const data = Array.isArray(result) ? { posts: result } : { post: result };
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      structuredContent: data,
      isError: !Array.isArray(result) && result.state === 'failed',
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
}

/** Only input schemas, tool descriptions, and delegation belong in this layer. */
export function createMcpServer(service: QueueService): FastMCP {
  const server = new FastMCP({
    name: 'finplayeros-threads-mcp', version: '0.1.0',
    ping: { enabled: false }, roots: { enabled: false },
    // Framework logs can contain request arguments. Suppress them; startup errors use sanitized stderr.
    logger: {
      debug: () => undefined, error: () => undefined, info: () => undefined,
      log: () => undefined, warn: () => undefined,
    },
  });

  server.addTool({
    name: 'create_draft',
    description: 'Create a local Threads draft for @finplayer_ceo. Does not approve or publish.',
    parameters: createDraftSchema,
    execute: (input) => runTool(() => service.createDraft(input)),
  });

  server.addTool({
    name: 'update_draft',
    description: 'Edit a draft or approved post. Editing an approved post resets it to draft and clears approval. Null clears optional metadata.',
    parameters: updateDraftSchema.safeExtend({ id: idSchema }),
    execute: ({ id, ...patch }) => runTool(() => service.updateDraft(id, patch)),
  });

  server.addTool({
    name: 'approve_draft',
    description: 'Explicit human approval gate. Invoke only after the human approves the exact draft content.',
    parameters: z.strictObject({ id: idSchema, approved_by: z.string().optional() }),
    execute: ({ id, approved_by }) => runTool(() => service.approveDraft(id, approved_by)),
  });

  server.addTool({
    name: 'schedule_post',
    description: 'Store a future publish_at locally for an approved or failed post. Offset-free times use Asia/Hong_Kong. An external executor must call publish_now.',
    parameters: z.strictObject({ id: idSchema, publish_at: z.string() }),
    execute: ({ id, publish_at }) => runTool(() => service.schedulePost(id, publish_at)),
  });

  server.addTool({
    name: 'publish_now',
    description: 'Publish an approved, scheduled, or previously approved failed post. Uses a stub client; a media ID is required for published state.',
    parameters: z.strictObject({ id: idSchema }),
    timeoutMs: 360_000,
    execute: ({ id }) => runTool(() => service.publishNow(id)),
  });

  server.addTool({
    name: 'list_queue',
    description: 'List all queue posts with state, timestamps, publish_at, media ID, and last error; optionally filter by state.',
    parameters: z.strictObject({ state: postStateSchema.optional() }),
    annotations: { readOnlyHint: true },
    execute: ({ state }) => runTool(() => service.listQueue(state)),
  });

  server.addTool({
    name: 'cancel_scheduled',
    description: 'Cancel only a scheduled post, clear publish_at, and return it to approved.',
    parameters: z.strictObject({ id: idSchema }),
    execute: ({ id }) => runTool(() => service.cancelScheduled(id)),
  });

  return server;
}
