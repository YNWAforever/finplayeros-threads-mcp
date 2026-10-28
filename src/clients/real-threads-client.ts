import type { ContainerInput, ContainerStatusResult, ThreadsClient } from './threads-client.js';

/** Task 1c placeholder. Deliberately contains no live HTTP code or credential handling. */
export class RealThreadsClient implements ThreadsClient {
  async createContainer(_input: ContainerInput): Promise<{ id: string }> {
    throw new Error('not configured — awaiting Meta app + OAuth (Task 1c)');
  }

  async getContainerStatus(_containerId: string): Promise<ContainerStatusResult> {
    throw new Error('not configured — awaiting Meta app + OAuth (Task 1c)');
  }

  async publishContainer(_containerId: string): Promise<{ id: string }> {
    throw new Error('not configured — awaiting Meta app + OAuth (Task 1c)');
  }
}
