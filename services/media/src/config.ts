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
import { defaultPathStyleFor, defaultPublicBaseUrl, defaultRegionFor } from './storage/url';

/** Dev/compose defaults, shared by the schema and by the derived settings
 *  (publicBaseUrl/region/pathStyle) that need the EFFECTIVE values. */
const S3_DEFAULTS = {
  endpoint: 'http://localhost:9000',
  accessKey: 'gather',
  secretKey: 'gather-secret',
  bucket: 'gather-media',
} as const;

/**
 * Each setting's accepted env names, most explicit first. The second name is
 * what a linked Railway Bucket injects, so a linked bucket needs no manual
 * mapping — and an existing deploy that sets S3_* by hand always wins.
 */
const S3_ENV_NAMES = {
  endpoint: ['S3_ENDPOINT', 'ENDPOINT'],
  region: ['S3_REGION', 'REGION'],
  accessKey: ['S3_ACCESS_KEY', 'ACCESS_KEY_ID'],
  secretKey: ['S3_SECRET_KEY', 'SECRET_ACCESS_KEY'],
  bucket: ['S3_BUCKET', 'BUCKET'],
} as const;

/** Settings without which the storage client cannot address or sign anything.
 *  region/publicBaseUrl/pathStyle are all derivable, so they are not here. */
const S3_REQUIRED: readonly (keyof typeof S3_ENV_NAMES)[] = [
  'endpoint',
  'accessKey',
  'secretKey',
  'bucket',
];

/** Presence of any of these means storage is MEANT to be configured, so a
 *  partial set must fail closed instead of silently falling back to the dev
 *  defaults. Railway's generic names are narrowed to the three that cannot
 *  plausibly belong to another service (REGION/ENDPOINT alone prove nothing). */
const S3_SIGNAL_VARS = [
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'S3_BUCKET',
  'S3_PUBLIC_BASE_URL',
  'S3_FORCE_PATH_STYLE',
  'BUCKET',
  'ACCESS_KEY_ID',
  'SECRET_ACCESS_KEY',
] as const;

export const configSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  port: z.coerce.number().int().min(1).max(65535).default(4500),
  /** Browser origin allowed to call the upload API (the web app). */
  appUrl: z.string().min(1).default('http://localhost:3000'),
  /** SAME secret as services/api — access tokens are issued there. */
  jwtSecret: z.string().min(1).default('dev-secret-gather-api'),
  /** null ⇒ the in-memory asset store is used (tests, storage-less dev). */
  mongoUrl: z.string().min(1).nullable().default(null),
  s3: z
    .object({
      endpoint: z.string().min(1).default(S3_DEFAULTS.endpoint),
      region: z.string().min(1).default('us-east-1'),
      accessKey: z.string().min(1).default(S3_DEFAULTS.accessKey),
      secretKey: z.string().min(1).default(S3_DEFAULTS.secretKey),
      bucket: z.string().min(1).default(S3_DEFAULTS.bucket),
      publicBaseUrl: z.string().min(1).default('http://localhost:9000/gather-media'),
      /** true ⇒ /bucket/key (MinIO); false ⇒ bucket.host/key (Railway/Tigris,
       *  AWS, R2). Derived from the endpoint unless S3_FORCE_PATH_STYLE says. */
      pathStyle: z
        .boolean({ invalid_type_error: "S3_FORCE_PATH_STYLE must be 'true' or 'false'" })
        .default(true),
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

/** First non-empty of `keys`, in order — earlier names win. */
function envFirst(
  env: Record<string, string | undefined>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = envStr(env, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Tri-state flag: unset ⇒ undefined, 'true'/'1' ⇒ true, 'false'/'0' ⇒ false.
 *  Anything else is returned verbatim so the schema rejects it by name. */
function envFlag(
  env: Record<string, string | undefined>,
  key: string,
): boolean | string | undefined {
  const value = envStr(env, key);
  if (value === undefined) return undefined;
  const lowered = value.toLowerCase();
  if (lowered === 'true' || lowered === '1') return true;
  if (lowered === 'false' || lowered === '0') return false;
  return value;
}

/**
 * Resolve the storage block from either env-var family. Fails closed: once
 * ANY storage var is present (or the pipeline is enabled in production), the
 * whole addressing/credential set must be present too, so a half-mapped
 * Railway link cannot silently fall back to the local MinIO defaults and then
 * 404 at upload time. Only var NAMES are ever put in the message.
 */
function resolveS3(
  env: Record<string, string | undefined>,
  requireExplicit: boolean,
): {
  endpoint: string | undefined;
  region: string;
  accessKey: string | undefined;
  secretKey: string | undefined;
  bucket: string | undefined;
  publicBaseUrl: string;
  pathStyle: boolean | string;
} {
  const resolved = {
    endpoint: envFirst(env, S3_ENV_NAMES.endpoint),
    region: envFirst(env, S3_ENV_NAMES.region),
    accessKey: envFirst(env, S3_ENV_NAMES.accessKey),
    secretKey: envFirst(env, S3_ENV_NAMES.secretKey),
    bucket: envFirst(env, S3_ENV_NAMES.bucket),
  };

  const configured = S3_SIGNAL_VARS.some((name) => envStr(env, name) !== undefined);
  if (configured || requireExplicit) {
    const missing = S3_REQUIRED.filter((field) => resolved[field] === undefined).map((field) =>
      S3_ENV_NAMES[field].join(' or '),
    );
    if (missing.length > 0) {
      const names = missing.join(', ');
      throw new AppError(
        'VALIDATION',
        `Invalid configuration — incomplete object storage config, missing: ${names}`,
      );
    }
  }

  // Derived settings need the EFFECTIVE endpoint/bucket, defaults included.
  const endpoint = resolved.endpoint ?? S3_DEFAULTS.endpoint;
  const bucket = resolved.bucket ?? S3_DEFAULTS.bucket;
  if (!URL.canParse(endpoint)) {
    throw new AppError(
      'VALIDATION',
      'Invalid configuration — S3_ENDPOINT (or ENDPOINT) must be an absolute URL',
    );
  }
  const pathStyle = envFlag(env, 'S3_FORCE_PATH_STYLE') ?? defaultPathStyleFor(endpoint);

  return {
    ...resolved,
    region: resolved.region ?? defaultRegionFor(endpoint),
    publicBaseUrl:
      envStr(env, 'S3_PUBLIC_BASE_URL') ??
      defaultPublicBaseUrl(endpoint, bucket, pathStyle === true),
    pathStyle,
  };
}

/**
 * Parse and validate an env dict into an AppConfig. Throws
 * AppError('VALIDATION') listing every offending setting when invalid, so a
 * misconfigured deploy fails fast at boot with a readable message.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  // Railway-style platforms inject PORT; the repo's own var is MEDIA_PORT.
  const port = envStr(env, 'PORT') ?? envStr(env, 'MEDIA_PORT');
  // A production deploy that actually runs the pipeline must not boot on the
  // dev MinIO credentials; with the pipeline off the service never touches S3.
  const pipelineOn = envBool(env, 'ENABLE_MEDIA_PIPELINE') ?? false;
  const s3 = resolveS3(env, envStr(env, 'NODE_ENV') === 'production' && pipelineOn);

  const input = {
    nodeEnv: envStr(env, 'NODE_ENV'),
    port,
    appUrl: envStr(env, 'APP_URL'),
    jwtSecret: envStr(env, 'JWT_SECRET'),
    mongoUrl: envStr(env, 'MONGO_URL'),
    s3,
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
