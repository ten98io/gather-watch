/**
 * Object-storage port. The real implementation is a minimal S3-compatible
 * client (storage/s3.ts) speaking raw SigV4 over fetch — deliberately NOT
 * @aws-sdk/client-s3, matching the repo precedent (services/api's chat
 * attachments hand-roll SigV4 against MinIO) and keeping the dependency graph
 * frozen-lockfile-safe. An aws-sdk-backed implementation can drop in behind
 * this interface without touching routes or the pipeline.
 */
export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface ObjectStorage {
  /** Endpoint reachability (drives /readyz). */
  ping(): Promise<boolean>;

  /** Start a multipart upload; resolves to the S3 uploadId. */
  createMultipartUpload(key: string, mime: string): Promise<string>;

  /** Presigned PUT URL for one part (query-signed SigV4, no network I/O). */
  presignUploadPart(key: string, uploadId: string, partNumber: number): string;

  /** Finalize a multipart upload. Parts must be in ascending partNumber order. */
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: readonly CompletedPart[],
  ): Promise<void>;

  abortMultipartUpload(key: string, uploadId: string): Promise<void>;

  getObject(key: string): Promise<Buffer>;
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  deleteObject(key: string): Promise<void>;
  /** Delete every object under `prefix` (paginated). */
  deletePrefix(prefix: string): Promise<void>;

  /** Public (CDN/MinIO) URL for a key. */
  publicUrl(key: string): string;
}
