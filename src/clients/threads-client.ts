export interface ContainerInput {
  text: string;
  image_url?: string;
}

export type ContainerStatus = 'FINISHED' | 'IN_PROGRESS' | 'ERROR' | 'EXPIRED' | 'PUBLISHED';

export interface ContainerStatusResult {
  status: ContainerStatus;
  error_message?: string;
}

export interface ThreadsClient {
  createContainer(input: ContainerInput): Promise<{ id: string }>;
  getContainerStatus(containerId: string): Promise<ContainerStatusResult>;
  publishContainer(containerId: string): Promise<{ id: string }>;
  getPublishingLimit?(): Promise<{ quota_usage: number; quota_total: number }>;
}
