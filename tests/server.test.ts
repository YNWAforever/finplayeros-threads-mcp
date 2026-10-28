import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FastMCP, type FastMCPSession } from 'fastmcp';
import { StubThreadsClient } from '../src/clients/stub-threads-client.js';
import { QueueService } from '../src/core/queue-service.js';
import { createMcpServer } from '../src/server.js';
import { InMemoryQueueStore } from '../src/stores/in-memory-queue-store.js';

describe('MCP server over in-memory transport', () => {
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;
  let session: FastMCPSession;

  beforeEach(async () => {
    let counter = 0;
    const service = new QueueService({
      store: new InMemoryQueueStore(),
      client: new StubThreadsClient(),
      newId: () => `mcp-post-${++counter}`,
      now: () => new Date('2026-10-29T00:00:00Z'),
    });
    server = createMcpServer(service);
    client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    [session] = await Promise.all([
      server.connect(serverTransport), client.connect(clientTransport),
    ]);
  });

  afterEach(async () => {
    await client.close();
    await session.close();
    await server.stop();
  });

  it('boots and exposes exactly the seven required tools', async () => {
    expect(server).toBeInstanceOf(FastMCP);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'approve_draft', 'cancel_scheduled', 'create_draft', 'list_queue',
      'publish_now', 'schedule_post', 'update_draft',
    ]);
    expect(tools.every((tool) => tool.inputSchema.type === 'object')).toBe(true);
    const create = tools.find((tool) => tool.name === 'create_draft');
    expect(Object.keys(create?.inputSchema.properties ?? {}).sort()).toEqual(['image_ref', 'link', 'source_note', 'text']);
  });

  it('enforces approval and supports the whole scheduled publish flow via tools', async () => {
    const created = await client.callTool({ name: 'create_draft', arguments: { text: '大家好😀' } });
    expect(created.structuredContent).toMatchObject({ post: { id: 'mcp-post-1', state: 'draft' } });
    const id = 'mcp-post-1';
    const rejected = await client.callTool({ name: 'publish_now', arguments: { id } });
    expect(rejected.isError).toBe(true);
    await client.callTool({ name: 'update_draft', arguments: { id, text: '修改之後😀' } });
    await client.callTool({ name: 'approve_draft', arguments: { id, approved_by: 'Willy' } });
    const edited = await client.callTool({ name: 'update_draft', arguments: { id, text: '禁止修改' } });
    expect(edited.isError).toBe(false);
    expect(edited.structuredContent).toMatchObject({ post: { state: 'draft' } });
    const blocked = await client.callTool({ name: 'schedule_post', arguments: { id, publish_at: '2026-10-30T09:00' } });
    expect(blocked.isError).toBe(true);
    await client.callTool({ name: 'approve_draft', arguments: { id, approved_by: 'Willy' } });
    await client.callTool({ name: 'schedule_post', arguments: { id, publish_at: '2026-10-30T09:00' } });
    const cancelled = await client.callTool({ name: 'cancel_scheduled', arguments: { id } });
    expect(cancelled.structuredContent).toMatchObject({ post: { state: 'approved' } });
    await client.callTool({ name: 'schedule_post', arguments: { id, publish_at: '2026-10-30T09:00' } });
    const published = await client.callTool({ name: 'publish_now', arguments: { id } });
    expect(published.isError).toBe(false);
    expect(published.structuredContent).toMatchObject({ post: { state: 'published', threads_media_id: 'stub-media-000001' } });
    const listed = await client.callTool({ name: 'list_queue', arguments: { state: 'published' } });
    expect(listed.structuredContent).toMatchObject({ posts: [{ id, state: 'published' }] });
  });

  it('rejects caller-supplied state and approval fields', async () => {
    await expect(client.callTool({
      name: 'create_draft', arguments: { text: 'test', state: 'approved', approved_at: '2026-10-29T00:00:00Z' },
    })).rejects.toMatchObject({ code: -32602 });
    const listed = await client.callTool({ name: 'list_queue', arguments: {} });
    expect(listed.structuredContent).toEqual({ posts: [] });
  });

  it('surfaces failed publishing as an MCP error with persisted queue state', async () => {
    await client.callTool({ name: 'create_draft', arguments: { text: 'image', image_ref: './image.png' } });
    await client.callTool({ name: 'approve_draft', arguments: { id: 'mcp-post-1' } });
    const result = await client.callTool({ name: 'publish_now', arguments: { id: 'mcp-post-1' } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ post: { state: 'failed', last_error: expect.stringContaining('not configured') } });
    const listed = await client.callTool({ name: 'list_queue', arguments: { state: 'failed' } });
    expect(listed.structuredContent).toMatchObject({ posts: [{ state: 'failed' }] });
  });
});
