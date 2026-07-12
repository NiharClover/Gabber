// Storage abstraction for uploaded media (avatars, chat images, voice notes).
//
// Local disk storage does not survive a server restart on ephemeral compute
// (ECS Fargate tasks, ASG instance replacement) and cannot be shared across
// multiple instances behind a load balancer — every instance would have a
// different set of files on disk. This module switches to S3 automatically
// once AWS credentials + AWS_S3_BUCKET are configured, and falls back to the
// existing local-disk behavior otherwise so local dev keeps working
// unchanged.
//
// To activate S3:
//   npm install @aws-sdk/client-s3
//   Set in .env: AWS_S3_BUCKET, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
//   (or use an IAM role on the ECS task instead of static keys — preferred
//   in production; the SDK picks up either automatically)
//
// Until AWS_S3_BUCKET is set, this transparently uses local disk exactly as
// before — nothing breaks if you deploy this file without doing the AWS
// setup yet.

const fs = require("fs");
const path = require("path");

const USE_S3 = !!process.env.AWS_S3_BUCKET;

let s3Client = null;
let PutObjectCommand = null;

if (USE_S3) {
  try {
    const { S3Client, PutObjectCommand: PutCmd } = require("@aws-sdk/client-s3");
    s3Client = new S3Client({ region: process.env.AWS_REGION || "ap-south-1" });
    PutObjectCommand = PutCmd;
    console.log("[storage] Using S3 bucket:", process.env.AWS_S3_BUCKET);
  } catch (err) {
    console.error(
      "[storage] AWS_S3_BUCKET is set but @aws-sdk/client-s3 is not installed. " +
      "Run `npm install @aws-sdk/client-s3`. Falling back to local disk for now."
    );
  }
} else {
  console.log("[storage] AWS_S3_BUCKET not set — using local disk (D:\\Gabber\\uploads). Fine for dev, not for multi-instance production.");
}

/**
 * Uploads a buffer and returns a publicly-accessible absolute URL.
 *
 * @param {Buffer} buffer       file contents
 * @param {string} subfolder    e.g. "avatars", "voice", "" (chat images root)
 * @param {string} filename     final filename, e.g. "avatar_abc123.jpg"
 * @param {string} contentType  e.g. "image/jpeg", "audio/m4a"
 * @param {object} req          the Express request — used to build the local
 *                               fallback URL from the actual host the client
 *                               connected to (never hardcode localhost here)
 */
async function uploadBuffer(buffer, subfolder, filename, contentType, req) {
  if (USE_S3 && s3Client) {
    const key = subfolder ? `${subfolder}/${filename}` : filename;
    await s3Client.send(
      new PutObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        // Bucket should have a public-read policy scoped to this prefix,
        // or front it with CloudFront — ACLs are deprecated on new buckets.
      })
    );
    const cdnBase = process.env.AWS_CLOUDFRONT_URL;
    if (cdnBase) return `${cdnBase.replace(/\/$/, "")}/${key}`;
    return `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION || "ap-south-1"}.amazonaws.com/${key}`;
  }

  // Local disk fallback — matches the previous behavior of media.js, but
  // fixed to build the URL from the actual request host instead of a
  // hardcoded/misconfigured BASE_URL env var (that was the root cause of
  // avatars appearing broken on-device: the server returned
  // "http://localhost:3000/..." which means something different on the
  // phone than it does on the dev machine).
  const uploadDir = path.join(__dirname, "../../uploads", subfolder);
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
  const filepath = path.join(uploadDir, filename);
  fs.writeFileSync(filepath, buffer);

  const urlPath = subfolder ? `/uploads/${subfolder}/${filename}` : `/uploads/${filename}`;
  return `${req.protocol}://${req.get("host")}${urlPath}`;
}

/**
 * Deletes a previously-uploaded file. Used for view-once photo cleanup.
 * `urlOrFilename` may be a full URL (extracts the key) or a bare filename.
 */
async function deleteFile(urlOrFilename, subfolder = "") {
  if (USE_S3 && s3Client) {
    try {
      const { DeleteObjectCommand } = require("@aws-sdk/client-s3");
      const key = subfolder
        ? `${subfolder}/${urlOrFilename.split("/").pop()}`
        : urlOrFilename.split("/").pop();
      await s3Client.send(new DeleteObjectCommand({ Bucket: process.env.AWS_S3_BUCKET, Key: key }));
    } catch (err) {
      console.error("[storage] S3 delete failed:", err.message);
    }
    return;
  }

  try {
    const filename = urlOrFilename.split("/").pop();
    const filepath = path.join(__dirname, "../../uploads", subfolder, filename);
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
  } catch (err) {
    console.error("[storage] Local delete failed:", err.message);
  }
}

module.exports = { uploadBuffer, deleteFile, USE_S3 };