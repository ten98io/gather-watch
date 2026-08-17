/**
 * Central typed configuration. Every module reads config from here (via Deps)
 * instead of touching process.env, so env parsing/validation happens exactly
 * once at boot and tests can inject a hand-built AppConfig.
 *
 * Convention: an env var set to the EMPTY STRING counts as absent (compose and
 * .env.example both emit empty vars), which yields the default — or null for
 * optional integrations.
 */
import { z } from 'zod';
import { AppError } from './lib/errors';

export const configSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  port: z.coerce.number().int().min(1).max(65535).default(4000),
  appUrl: z.string().min(1).default('http://localhost:3000'),
  apiUrl: z.string().min(1).default('http://localhost:4000'),
  jwtSecret: z.string().min(1).default('dev-secret-gather-api'),
  jwtRefreshSecret: z.string().min(1).default('dev-refresh-secret-gather-api'),
  magicLinkTtlMin: z.coerce.number().int().min(1).default(15),
  accessTokenTtlSec: z.coerce.number().int().min(1).default(900),
  refreshTtlDays: z.coerce.number().int().min(1).default(30),
  smtp: z
    .object({
      host: z.string().min(1).nullable().default(null),
      port: z.coerce.number().int().min(1).max(65535).default(587),
      user: z.string().min(1).nullable().default(null),
      pass: z.string().min(1).nullable().default(null),
      from: z.string().min(1).default('Gather <no-reply@gather.local>'),
    })
    .default({}),
  // null ⇒ the in-memory adapters are used (see adapters/index.ts).
  mongoUrl: z.string().min(1).nullable().default(null),
  redisUrl: z.string().min(1).nullable().default(null),
  turnStaticAuthSecret: z.string().min(1).nullable().default(null),
  s3: z
    .object({
      endpoint: z.string().min(1).default('http://localhost:9000'),
      accessKey: z.string().min(1).default('gather'),
      secretKey: z.string().min(1).default('gather-secret'),
      bucket: z.string().min(1).default('gather-media'),
      publicBaseUrl: z.string().min(1).default('http://localhost:9000/gather-media'),
    })
    .default({}),
  ffmpegPath: z.string().min(1).default('ffmpeg'),
  storageQuotaGb: z.coerce.number().int().min(1).default(10),
  cloudflare: z
    .object({
      turnKeyId: z.string().min(1).nullable().default(null),
      turnApiToken: z.string().min(1).nullable().default(null),
      sfuAppId: z.string().min(1).nullable().default(null),
      sfuApiToken: z.string().min(1).nullable().default(null),
      // Cloudflare Email Service (magic-link delivery). BOTH the account id
      // and the token must be present before the API transport is used;
      // emailApiToken is a SECRET and never leaves an Authorization header.
      emailAccountId: z.string().min(1).nullable().default(null),
      emailApiToken: z.string().min(1).nullable().default(null),
      emailFrom: z.string().min(1).default('Gather <no-reply@gather.local>'),
    })
    .default({}),
  freeTurnCapGbPerMonth: z.coerce.number().int().min(0).default(20),
  stripe: z
    .object({
      secretKey: z.string().min(1).nullable().default(null),
      webhookSecret: z.string().min(1).nullable().default(null),
      pricePremiumMonthly: z.string().min(1).nullable().default(null),
    })
    .default({}),
  enableMediaPipeline: z.boolean().default(false),
  tenorApiKey: z.string().min(1).nullable().default(null),
  vapid: z
    .object({
      publicKey: z.string().min(1).nullable().default(null),
      privateKey: z.string().min(1).nullable().default(null),
      subject: z.string().min(1).default('mailto:admin@gather.local'),
    })
    .default({}),
  rateLimit: z
    .object({
      max: z.coerce.number().int().min(1).default(300),
      windowMs: z.coerce.number().int().min(1).default(60000),
      authMax: z.coerce.number().int().min(1).default(20),
    })
    .default({}),
  /** Platform-owner inboxes. Users whose verified email is listed here get the
   *  /admin ops surface (REST + web panel). Guests can never be admin. */
  adminEmails: z.array(z.string().email()).default([]),
});

export type AppConfig = z.infer<typeof configSchema>;

/** An env var present but empty is ABSENT — compose/.env.example emit those. */
function envStr(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key];
  return value === undefined || value.trim() === '' ? undefined : value;
}

/** 'true'/'1' (case-insensitive) enable a flag; anything else means default. */
function envBool(env: Record<string, string | undefined>, key: string): boolean | undefined {
  const value = envStr(env, key);
  if (value === undefined) return undefined;
  const lowered = value.toLowerCase();
  return lowered === 'true' || lowered === '1';
}

/**
 * Parse and validate an env dict into an AppConfig. Throws
 * AppError('VALIDATION') listing every offending setting when invalid, so a
 * misconfigured deploy fails fast at boot with a readable message instead of
 * a confusing runtime error deep inside a module.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  // Railway-style platforms inject PORT; the repo's own var is API_PORT.
  const port = envStr(env, 'PORT') ?? envStr(env, 'API_PORT');

  const input = {
    nodeEnv: envStr(env, 'NODE_ENV'),
    port,
    appUrl: envStr(env, 'APP_URL'),
    apiUrl: envStr(env, 'API_URL'),
    jwtSecret: envStr(env, 'JWT_SECRET'),
    jwtRefreshSecret: envStr(env, 'JWT_REFRESH_SECRET'),
    magicLinkTtlMin: envStr(env, 'MAGIC_LINK_TTL_MIN'),
    accessTokenTtlSec: envStr(env, 'ACCESS_TOKEN_TTL_SEC'),
    refreshTtlDays: envStr(env, 'REFRESH_TTL_DAYS'),
    smtp: {
      host: envStr(env, 'SMTP_HOST'),
      port: envStr(env, 'SMTP_PORT'),
      user: envStr(env, 'SMTP_USER'),
      pass: envStr(env, 'SMTP_PASS'),
      from: envStr(env, 'SMTP_FROM'),
    },
    mongoUrl: envStr(env, 'MONGO_URL'),
    redisUrl: envStr(env, 'REDIS_URL'),
    turnStaticAuthSecret: envStr(env, 'TURN_STATIC_AUTH_SECRET'),
    s3: {
      endpoint: envStr(env, 'S3_ENDPOINT'),
      accessKey: envStr(env, 'S3_ACCESS_KEY'),
      secretKey: envStr(env, 'S3_SECRET_KEY'),
      bucket: envStr(env, 'S3_BUCKET'),
      publicBaseUrl: envStr(env, 'S3_PUBLIC_BASE_URL'),
    },
    ffmpegPath: envStr(env, 'FFMPEG_PATH'),
    storageQuotaGb: envStr(env, 'STORAGE_QUOTA_GB'),
    cloudflare: {
      turnKeyId: envStr(env, 'CF_TURN_KEY_ID'),
      turnApiToken: envStr(env, 'CF_TURN_API_TOKEN'),
      sfuAppId: envStr(env, 'CF_SFU_APP_ID'),
      sfuApiToken: envStr(env, 'CF_SFU_API_TOKEN'),
      emailAccountId: envStr(env, 'CF_EMAIL_ACCOUNT_ID'),
      emailApiToken: envStr(env, 'CF_EMAIL_API_TOKEN'),
      emailFrom: envStr(env, 'CF_EMAIL_FROM'),
    },
    freeTurnCapGbPerMonth: envStr(env, 'FREE_TURN_CAP_GB_PER_MONTH'),
    stripe: {
      secretKey: envStr(env, 'STRIPE_SECRET_KEY'),
      webhookSecret: envStr(env, 'STRIPE_WEBHOOK_SECRET'),
      pricePremiumMonthly: envStr(env, 'STRIPE_PRICE_PREMIUM_MONTHLY'),
    },
    enableMediaPipeline: envBool(env, 'ENABLE_MEDIA_PIPELINE'),
    tenorApiKey: envStr(env, 'TENOR_API_KEY'),
    vapid: {
      publicKey: envStr(env, 'VAPID_PUBLIC_KEY'),
      privateKey: envStr(env, 'VAPID_PRIVATE_KEY'),
      subject: envStr(env, 'VAPID_SUBJECT'),
    },
    rateLimit: {
      max: envStr(env, 'RATE_LIMIT_MAX'),
      windowMs: envStr(env, 'RATE_LIMIT_WINDOW_MS'),
      authMax: envStr(env, 'RATE_LIMIT_AUTH_MAX'),
    },
    adminEmails: envStr(env, 'ADMIN_EMAILS')
      ?.split(',')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
  };

  const parsed = configSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new AppError('VALIDATION', `Invalid configuration — ${issues}`);
  }
  const config = parsed.data;

  // The dev-secret defaults must never silently protect a production deploy.
  if (config.nodeEnv === 'production') {
    const problems: string[] = [];
    const jwtSecret = envStr(env, 'JWT_SECRET');
    const jwtRefreshSecret = envStr(env, 'JWT_REFRESH_SECRET');
    if (jwtSecret === undefined || jwtSecret.length < 32) {
      problems.push('JWT_SECRET must be set explicitly (>= 32 chars) in production');
    }
    if (jwtRefreshSecret === undefined || jwtRefreshSecret.length < 32) {
      problems.push('JWT_REFRESH_SECRET must be set explicitly (>= 32 chars) in production');
    }
    if (problems.length > 0) {
      throw new AppError('VALIDATION', `Invalid configuration — ${problems.join('; ')}`);
    }
  }

  return config;
}
