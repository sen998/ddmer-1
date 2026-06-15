import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function getS3Client(): S3Client {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error("Missing R2 credentials");
  }

  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
}

function getBucketName(): string {
  return process.env.R2_BUCKET_NAME || "kirameku-files";
}

export async function uploadFile(
  key: string,
  buffer: ArrayBuffer,
  contentType: string
): Promise<string> {
  const client = getS3Client();
  const bucket = getBucketName();

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: Buffer.from(buffer),
      ContentType: contentType,
    })
  );

  return getFileUrl(key);
}

export async function deleteFile(key: string): Promise<void> {
  const client = getS3Client();
  const bucket = getBucketName();

  try {
    await client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      })
    );
  } catch {
    // ignore
  }
}

export async function getFile(key: string): Promise<Buffer | null> {
  const client = getS3Client();
  const bucket = getBucketName();

  try {
    const response = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      })
    );
    if (!response.Body) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of response.Body as any) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

export function getFileUrl(key: string): string {
  const publicUrl = process.env.R2_PUBLIC_URL;
  if (publicUrl) {
    return `${publicUrl.replace(/\/$/, "")}/${key}`;
  }
  const accountId = process.env.R2_ACCOUNT_ID;
  const bucket = getBucketName();
  if (accountId) {
    return `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${key}`;
  }
  return `https://r2.cloudflarestorage.com/${bucket}/${key}`;
}

export function cleanUrlPath(url: string): string {
  try {
    const parsed = new URL(url);
    let path = parsed.pathname;
    const bucket = getBucketName();
    if (path.startsWith(`/${bucket}/`)) {
      path = path.slice(bucket.length + 2);
    }
    return path.replace(/^\//, "");
  } catch {
    return url.replace(/^\//, "");
  }
}

export function generateFileName(ext: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${timestamp}-${random}.${ext}`;
}

export async function getPresignedUploadUrl(
  key: string,
  contentType: string,
  expiresIn: number = 300
): Promise<string> {
  const client = getS3Client();
  const bucket = getBucketName();
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(client, command, { expiresIn });
}
