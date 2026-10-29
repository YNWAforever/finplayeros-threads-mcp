import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { del, put, type PutBlobResult } from '@vercel/blob';
import type { HostedImage, ImageHostAdapter } from './image-host.js';

/** Official Blob SDK only. The token is injected; no CLI credentials or profiles are read. */
export class VercelBlobImageHost implements ImageHostAdapter {
  constructor(private readonly token?: string) {}

  async upload(localPathOrBuffer: string | Uint8Array, contentType: string): Promise<HostedImage> {
    if (!this.token?.trim()) {
      throw new Error('Image host not configured; BLOB_READ_WRITE_TOKEN is required for Vercel Blob.');
    }
    const extension = contentType === 'image/png' ? 'png' : contentType === 'image/jpeg' ? 'jpg' : undefined;
    if (!extension) throw new Error('Vercel Blob image uploads require PNG or JPEG contentType.');
    if (typeof localPathOrBuffer === 'string' && /^https?:\/\//i.test(localPathOrBuffer)) {
      throw new Error('image_ref must name a local PNG or JPEG; remote image downloads are not supported.');
    }
    const bytes = typeof localPathOrBuffer === 'string'
      ? await readFile(localPathOrBuffer) : Buffer.from(localPathOrBuffer);
    let result: PutBlobResult;
    try {
      result = await put(`finplayer/${randomUUID()}.${extension}`, bytes, {
        access: 'public', addRandomSuffix: true, contentType, token: this.token,
      });
    } catch {
      // Provider exceptions may contain request details. Do not persist or log credentials.
      throw new Error('Vercel Blob upload failed. Check Blob configuration and retry.');
    }
    if (new URL(result.url).protocol !== 'https:') {
      throw new Error('Vercel Blob must return a public HTTPS URL.');
    }
    return { publicUrl: result.url, deleteHandle: result.url };
  }

  async delete(handle: string): Promise<void> {
    // Useful for cleanup hooks in unconfigured/stub environments; never fall back to ambient auth.
    if (!this.token?.trim()) return;
    try {
      await del(handle, { token: this.token });
    } catch {
      throw new Error('Vercel Blob deletion failed.');
    }
  }
}
