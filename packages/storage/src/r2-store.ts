import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { MotionError, redact } from "@motion-mcp/shared";
import {
  type ArtifactBody,
  type ArtifactStore,
  assertContentType,
  assertExpiry,
  assertSafeKey,
  assertSafePrefix,
  type PutResult,
} from "./artifact-store.ts";

export interface R2Options {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Override for tests or S3-compatible gateways; defaults to `https://<account>.r2.cloudflarestorage.com`. */
  endpoint?: string;
}

function isNotFound(err: unknown): boolean {
  if (err instanceof S3ServiceException) {
    return err.name === "NotFound" || err.name === "NoSuchKey" || err.$metadata.httpStatusCode === 404;
  }
  return false;
}

function providerError(action: string, err: unknown): MotionError {
  const message = err instanceof Error ? err.message : String(err);
  const status = err instanceof S3ServiceException ? err.$metadata.httpStatusCode : undefined;
  return new MotionError("PROVIDER", `R2 ${action} failed: ${redact(message)}`, {
    cause: err,
    retryable: status === undefined || status >= 500 || status === 429,
    details: { status },
  });
}

/** Cloudflare R2 through the S3 API. URLs are presigned GETs; the bucket itself stays private. */
export class R2ArtifactStore implements ArtifactStore {
  readonly driver = "r2" as const;
  readonly bucket: string;
  private readonly client: S3Client;

  constructor(options: R2Options) {
    for (const field of ["accountId", "accessKeyId", "secretAccessKey", "bucket"] as const) {
      if (!options[field]) throw new MotionError("CONFIG", `R2 ${field} is not configured`);
    }
    if (!/^[a-f0-9]{32}$/i.test(options.accountId) && !options.endpoint) {
      throw new MotionError("CONFIG", "R2 account id must be a 32-character hex id");
    }
    this.bucket = options.bucket;
    this.client = new S3Client({
      region: "auto",
      endpoint: options.endpoint ?? `https://${options.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    });
  }

  async put(key: string, body: ArtifactBody, contentType: string): Promise<PutResult> {
    assertSafeKey(key);
    assertContentType(contentType);
    let payload: Uint8Array | ReturnType<typeof createReadStream>;
    let size: number;
    if (body instanceof Uint8Array) {
      payload = body;
      size = body.byteLength;
    } else {
      try {
        size = (await stat(body.path)).size;
      } catch (err) {
        throw new MotionError("NOT_FOUND", "Source file for artifact upload does not exist", { cause: err });
      }
      payload = createReadStream(body.path);
    }
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: payload,
          ContentType: contentType,
          ContentLength: size,
        }),
      );
    } catch (err) {
      throw providerError("put", err);
    }
    return { key, size, contentType };
  }

  async get(key: string): Promise<Buffer> {
    assertSafeKey(key);
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!out.Body) throw new MotionError("NOT_FOUND", `Artifact not found: ${key}`);
      return Buffer.from(await out.Body.transformToByteArray());
    } catch (err) {
      if (err instanceof MotionError) throw err;
      if (isNotFound(err)) throw new MotionError("NOT_FOUND", `Artifact not found: ${key}`);
      throw providerError("get", err);
    }
  }

  async exists(key: string): Promise<boolean> {
    assertSafeKey(key);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw providerError("head", err);
    }
  }

  async url(key: string, options: { expiresIn?: number } = {}): Promise<string> {
    assertSafeKey(key);
    const expiresIn = assertExpiry(options.expiresIn);
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn });
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      if (isNotFound(err)) return;
      throw providerError("delete", err);
    }
  }

  async list(prefix: string): Promise<string[]> {
    assertSafePrefix(prefix);
    const keys: string[] = [];
    let token: string | undefined;
    try {
      do {
        const page = await this.client.send(
          new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
        );
        for (const obj of page.Contents ?? []) if (obj.Key) keys.push(obj.Key);
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
    } catch (err) {
      throw providerError("list", err);
    }
    return keys.sort();
  }

  destroy(): void {
    this.client.destroy();
  }
}
