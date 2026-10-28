import { DEFAULT_TIMEZONE } from './core/validation.js';
import { createRuntime } from './runtime.js';
import { createMcpServer } from './server.js';

async function main(): Promise<void> {
  process.env.TZ ||= DEFAULT_TIMEZONE;
  const { service, store } = createRuntime();
  const server = createMcpServer(service);
  try {
    await server.start({ transportType: 'stdio' });
  } catch (error) {
    store.close();
    throw error;
  }
}

void main().catch(() => {
  // Stdout is exclusively MCP JSON-RPC. Never log env values, tokens, or user content.
  process.stderr.write('Could not start Threads MCP; check local configuration.\n');
  process.exitCode = 1;
});
