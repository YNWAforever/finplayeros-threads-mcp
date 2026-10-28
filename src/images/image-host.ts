export interface HostedImage {
  publicUrl: string;
  deleteHandle: string;
}

export interface ImageHostAdapter {
  upload(localPathOrBuffer: string | Uint8Array, contentType: string): Promise<HostedImage>;
  delete(handle: string): Promise<void>;
}

/** Default for isolated core usage; the runtime supplies VercelBlobImageHost. */
export class NotConfiguredImageHost implements ImageHostAdapter {
  async upload(_localPathOrBuffer: string | Uint8Array, _contentType: string): Promise<HostedImage> {
    throw new Error('Image host not configured; BLOB_READ_WRITE_TOKEN is required for Vercel Blob.');
  }

  async delete(_handle: string): Promise<void> {
    // Nothing was uploaded by this adapter, so there is nothing to delete.
  }
}
