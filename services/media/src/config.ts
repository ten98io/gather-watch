/**
 * Central typed configuration, mirroring services/api conventions: every
 * module reads config via Deps instead of touching process.env; env parsing
 * happens exactly once at boot and tests inject a hand-built AppConfig.
 *
 * Convention: an env var set to the EMPTY STRING counts as absent (compose and
 * .env.example both emit empty vars), which yields the default.
 */
import { z } from 'zod';
import { AppError } from './lib/errors';

export const configSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  port: z.coerce.number().int().min(1).max(65535).default(4500),
  /** Browser origin allowed to call the upload API (the web app). */
  appUrl: z.string().min(1).default('http://localhost:3000'),
  /** SAME secret as services/api — access tokens are issued there. */
  jwtSecret: z.string().min(1).default('dev-secret-playin-api'),
  /** null ⇒ the in-memory asset store is used (tests, storage-less dev). */
  mongoUrl: z.string().min(1).nullable().default(null),
  s3: z
    .object({
      endpoint: z.string().min(1).default('http://localhost:9000'),
      region: z.string().min(1).default('us-east-1'),
      accessKey: z.string().min(1).default('playin'),
      secretKey: z.string().min(1).default('playin-secret'),
      bucket: z.string().min(1).default('playin-media'),
      publicBaseUrl: z.string().min(1).default('http://localhost:9000/playin-media'),
    })
    .default({}),
  ffmpegPath: z.string().min(1).default('ffmpeg'),
  ffprobePath: z.string().min(1).default('ffprobe'),
  /** Per-user library quota (sum of sizeBytes over the user's assets). */
  storageQuotaGb: z.coerce.number().int().min(1).default(10),
  /** Hard cap on a single uploaded file. */
  maxFileSizeGb: z.coerce.number().int().min(1).default(4),
  /** S3 multipart part size (min 5 per S3 rules); auto-grows to stay under
   *  the 10 000-part ceiling. */
  uploadPartSizeMb: z.coerce.number().int().min(5).max(5 * 1024).default(8),
  /** Lifetime of the presigned part URLs handed to clients. */
  presignTtlSec: z.coerce.number().int().min(60).max(60 * 60 * 24).default(900),
  /** v3.1 pivot: the HLS pipeline is an OPTIONAL module, default OFF. When
   *  false the service boots healthy but answers the upload/library surface
   *  with 501 — P2P file streaming is the default watch path. */
  enableMediaPipeline: z.boolean().default(false),
  /** Per-user (fallback per-IP) request ceiling — every POST /uploads mints
   *  a real S3 multipart session, so the surface must not be free to spam. */
  rateLimitMax: z.coerce.number().int().min(1).default(120),
  rateLimitWindowMs: z.coerce.number().int().min(1000).default(60_000),
});

export type AppConfig = z.infer<typeof configSchema>;

/** An env var present but empty is ABSENT — compose/.env.example emit those. */
function envStr(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key];
  return value === undefined || value.trim() === '' ? undefined : value;
}

/** Boolean env: 'true'/'1' (any case) ⇒ true; everything else ⇒ false. */
function envBool(env: Record<string, string | undefined>, key: string): boolean | undefined {
  const value = envStr(env, key);
  if (value === undefined) return undefined;
  const lowered = value.toLowerCase();
  return lowered === 'true' || lowered === '1';
}

/**
 * Parse and validate an env dict into an AppConfig. Throws
 * AppError('VALIDATION') listing every offending setting when invalid, so a
 * misconfigured deploy fails fast at boot with a readable message.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  // Railway-style platforms inject PORT; the repo's own var is MEDIA_PORT.
  const port = envStr(env, 'PORT') ?? envStr(env, 'MEDIA_PORT');

  const input = {
    nodeEnv: envStr(env, 'NODE_ENV'),
    port,
    appUrl: envStr(env, 'APP_URL'),
    jwtSecret: envStr(env, 'JWT_SECRET'),
    mongoUrl: envStr(env, 'MONGO_URL'),
    s3: {
      endpoint: envStr(env, 'S3_ENDPOINT'),
      region: envStr(env, 'S3_REGION'),
      accessKey: envStr(env, 'S3_ACCESS_KEY'),
      secretKey: envStr(env, 'S3_SECRET_KEY'),
      bucket: envStr(env, 'S3_BUCKET'),
      publicBaseUrl: envStr(env, 'S3_PUBLIC_BASE_URL'),
    },
    ffmpegPath: envStr(env, 'FFMPEG_PATH'),
    ffprobePath: envStr(env, 'FFPROBE_PATH'),
    storageQuotaGb: envStr(env, 'STORAGE_QUOTA_GB'),
    maxFileSizeGb: envStr(env, 'MAX_FILE_SIZE_GB'),
    uploadPartSizeMb: envStr(env, 'UPLOAD_PART_SIZE_MB'),
    presignTtlSec: envStr(env, 'UPLOAD_PRESIGN_TTL_SEC'),
    enableMediaPipeline: envBool(env, 'ENABLE_MEDIA_PIPELINE'),
    rateLimitMax: envStr(env, 'RATE_LIMIT_MAX'),
    rateLimitWindowMs: envStr(env, 'RATE_LIMIT_WINDOW_MS'),
  };

  const parsed = configSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new AppError('VALIDATION', `Invalid configuration — ${issues}`);
  }
  const config = parsed.data;

  // The dev-secret default must never silently protect a production deploy.
  if (config.nodeEnv === 'production') {
    const jwtSecret = envStr(env, 'JWT_SECRET');
    if (jwtSecret === undefined || jwtSecret.length < 32) {
      throw new AppError(
        'VALIDATION',
        'Invalid configuration — JWT_SECRET must be set explicitly (>= 32 chars) in production',
      );
    }
  }

  return config;
}
