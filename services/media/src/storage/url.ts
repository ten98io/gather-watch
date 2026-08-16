/**
 * S3 addressing. Two incompatible URL shapes exist and a wrong choice never
 * surfaces as a config error — it surfaces as a 404 or a SigV4 signature
 * mismatch, because the bucket position also changes the canonical URI and the
 * signed Host header:
 *
 *   path-style       http://endpoint/BUCKET/key   (MinIO's default)
 *   virtual-hosted   https://BUCKET.endpoint/key  (AWS, Cloudflare R2, and
 *                                                  Tigris — which is what
 *                                                  Railway Buckets run on)
 *
 * Every URL, canonical URI and Host header is therefore built here from one
 * resolved `pathStyle` flag rather than assembled ad hoc at each call site.
 * Pure string helpers only — config.ts imports this, so it must not import
 * config.
 */

/** S3 uriEncode: RFC 3986 — encodeURIComponent plus the missing !'()* chars. */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Key segments encode individually — '/' stays a path separator. */
export function encodeKey(key: string): string {
  return key.split('/').map(uriEncode).join('/');
}

/**
 * Endpoint hosts whose S3 API is virtual-hosted. Everything else keeps
 * path-style, so a hand-configured MinIO (which needs wildcard DNS plus
 * MINIO_DOMAIN before it can answer virtual-hosted requests) is unaffected.
 */
const VIRTUAL_HOSTED_SUFFIXES = [
  'railway.app',
  'tigris.dev',
  'amazonaws.com',
  'r2.cloudflarestorage.com',
] as const;

/** Providers that ignore the region but demand the literal 'auto' in SigV4. */
const AUTO_REGION_SUFFIXES = ['railway.app', 'tigris.dev', 'r2.cloudflarestorage.com'] as const;

function hostname(endpoint: string): string {
  return new URL(endpoint).hostname.toLowerCase();
}

function hostMatches(host: string, suffixes: readonly string[]): boolean {
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** True when the endpoint's provider serves buckets as subdomains. */
export function isVirtualHostedEndpoint(endpoint: string): boolean {
  return hostMatches(hostname(endpoint), VIRTUAL_HOSTED_SUFFIXES);
}

/** Region when none is configured: Railway/Tigris sign with 'auto'. */
export function defaultRegionFor(endpoint: string): string {
  return hostMatches(hostname(endpoint), AUTO_REGION_SUFFIXES) ? 'auto' : 'us-east-1';
}

/** Default addressing for an endpoint — path-style unless the provider needs
 *  virtual-hosted. Overridden by S3_FORCE_PATH_STYLE. */
export function defaultPathStyleFor(endpoint: string): boolean {
  return !isVirtualHostedEndpoint(endpoint);
}

/** An endpoint may carry a port and (rarely) a path prefix; both are part of
 *  the request and the prefix must appear in the signed canonical URI. */
function endpointParts(endpoint: string): { protocol: string; host: string; basePath: string } {
  const url = new URL(endpoint);
  return { protocol: url.protocol, host: url.host, basePath: url.pathname.replace(/\/+$/, '') };
}

/** Scheme + authority the request is sent to (bucket subdomain when
 *  virtual-hosted). Its host half is what SigV4 signs as `host`. */
export function requestOrigin(endpoint: string, bucket: string, pathStyle: boolean): string {
  const { protocol, host } = endpointParts(endpoint);
  return pathStyle ? `${protocol}//${host}` : `${protocol}//${bucket}.${host}`;
}

/** Value of the signed `host` header — MUST match requestOrigin's authority. */
export function requestHost(endpoint: string, bucket: string, pathStyle: boolean): string {
  const { host } = endpointParts(endpoint);
  return pathStyle ? host : `${bucket}.${host}`;
}

/** Canonical URI for an object request (already percent-encoded). */
export function objectPath(
  endpoint: string,
  bucket: string,
  key: string,
  pathStyle: boolean,
): string {
  const { basePath } = endpointParts(endpoint);
  return pathStyle ? `${basePath}/${bucket}/${encodeKey(key)}` : `${basePath}/${encodeKey(key)}`;
}

/** Canonical URI for a bucket-level request (HEAD bucket, ListObjectsV2). */
export function bucketPath(endpoint: string, bucket: string, pathStyle: boolean): string {
  const { basePath } = endpointParts(endpoint);
  return pathStyle ? `${basePath}/${bucket}` : `${basePath}/`;
}

/**
 * Public object base when S3_PUBLIC_BASE_URL is not set: the object URL minus
 * the key. On a virtual-hosted provider that is `https://BUCKET.endpoint-host`
 * — correct in shape, but it only resolves for a bucket that actually allows
 * anonymous reads (Railway Buckets do NOT by default; see the storage notes in
 * .env.example). Put a CDN or a presigning route in front and set
 * S3_PUBLIC_BASE_URL when the bucket stays private.
 */
export function defaultPublicBaseUrl(endpoint: string, bucket: string, pathStyle: boolean): string {
  const { basePath } = endpointParts(endpoint);
  const origin = `${requestOrigin(endpoint, bucket, pathStyle)}${basePath}`;
  return pathStyle ? `${origin}/${bucket}` : origin;
}
