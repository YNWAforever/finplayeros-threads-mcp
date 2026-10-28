import type { ContainerInput, ContainerStatusResult, ThreadsClient } from './threads-client.js';

export type StubMode = 'success' | 'fail';

export interface StubThreadsClientOptions {
  mode?: StubMode;
  failAt?: 'create' | 'status' | 'publish';
  statuses?: ContainerStatusResult[];
}

/** Deterministic local simulation. Never reads credentials or performs HTTP. */
export class StubThreadsClient implements ThreadsClient {
  private mode: StubMode;
  private readonly failAt: 'create' | 'status' | 'publish';
  private readonly statuses: ContainerStatusResult[];
  private nextContainer = 1;
  private readonly containers = new Map<string, { checks: number; published: boolean }>();

  constructor(options: StubThreadsClientOptions = {}) {
    this.mode = options.mode ?? 'success';
    this.failAt = options.failAt ?? 'create';
    this.statuses = options.statuses?.length ? structuredClone(options.statuses) : [{ status: 'FINISHED' }];
  }

  setMode(mode: StubMode): void {
    this.mode = mode;
  }

  async createContainer(_input: ContainerInput): Promise<{ id: string }> {
    this.maybeFail('create');
    const id = `stub-container-${String(this.nextContainer++).padStart(6, '0')}`;
    this.containers.set(id, { checks: 0, published: false });
    return { id };
  }

  async getContainerStatus(containerId: string): Promise<ContainerStatusResult> {
    this.maybeFail('status');
    const container = this.getContainer(containerId);
    if (container.published) return { status: 'PUBLISHED' };
    const status = this.statuses[Math.min(container.checks++, this.statuses.length - 1)];
    if (!status) throw new Error('Stub status sequence is empty.');
    return structuredClone(status);
  }

  async publishContainer(containerId: string): Promise<{ id: string }> {
    this.maybeFail('publish');
    const container = this.getContainer(containerId);
    if (container.published) throw new Error('Stub container was already published.');
    container.published = true;
    return { id: containerId.replace('stub-container-', 'stub-media-') };
  }

  private maybeFail(stage: 'create' | 'status' | 'publish'): void {
    if (this.mode === 'fail' && this.failAt === stage) {
      throw new Error(`Stub Threads failure at ${stage}.`);
    }
  }

  private getContainer(id: string): { checks: number; published: boolean } {
    const container = this.containers.get(id);
    if (!container) throw new Error('Unknown stub container.');
    return container;
  }
}
