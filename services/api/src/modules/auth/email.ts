/**
 * Magic-link delivery. Three transports, tried in a fixed order:
 *   1. Cloudflare Email Service REST API — when an account id AND an API
 *      token are configured.
 *   2. SMTP via nodemailer — when SMTP_HOST is set.
 *   3. The link is logged. This is the DEV FLOW and never an error: local
 *      development signs in by reading the link out of the API log.
 *
 * FAILURE POSTURE (recorded decision): a CONFIGURED transport that fails
 * REJECTS, so POST /auth/magic-link answers 500 instead of `{ ok: true }`.
 * Swallowing the failure would leave the user watching an inbox for a mail
 * that will never arrive; a 500 lets the client say "that didn't send, try
 * again". Case 3 is not a failure — no transport is configured at all, which
 * is a deliberate mode, so it resolves.
 *
 * SECRET HANDLING: the API token travels only in an Authorization header —
 * never in a URL, never in a log line, never in an Error. Cloudflare's error
 * body is truncated AND token-scrubbed before it is logged, and the caller
 * only ever sees one fixed opaque message.
 */
import nodemailer from 'nodemailer';
import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from '../../config';
import { AppError } from '../../lib/errors';

export interface MagicLinkMail {
  to: string;
  link: string;
  kind: 'magic-link' | 'guest-upgrade';
}

export interface Mailer {
  send(mail: MagicLinkMail): Promise<void>;
}

/**
 * One attempt, 8s deadline. The caller is a BLOCKED sign-in request, so the
 * bound must sit well under a typical 30s gateway idle timeout; the endpoint
 * only accepts the message for delivery, so 8s is generous for a TLS
 * handshake plus an accept. There is deliberately NO retry: the endpoint
 * takes no idempotency key, and a timeout cannot distinguish "never arrived"
 * from "accepted, reply lost" — a resend would deliver two sign-in links.
 */
export const CF_EMAIL_TIMEOUT_MS = 8000;

/** Cloudflare error bodies are logged truncated to this many characters. */
const CF_ERROR_BODY_MAX = 512;

const SUBJECT = 'Your Playin sign-in link';

/** The ONLY failure the caller sees: no status, no provider body, no token. */
function sendFailed(): AppError {
  return new AppError('INTERNAL', 'could not send the sign-in email');
}

function textBody(link: string): string {
  return `Sign in to Playin: ${link}`;
}

function htmlBody(link: string): string {
  return `<p>Sign in to Playin: <a href="${link}">${link}</a></p>`;
}

/**
 * Cloudflare Email Service transport. The payload is a two-line message —
 * orders of magnitude under the API's 5 MiB total-message cap, so no size
 * guard is needed here.
 */
function createCloudflareMailer(
  accountId: string,
  apiToken: string,
  from: string,
  log: FastifyBaseLogger,
): Mailer {
  const url =
    `https://api.cloudflare.com/client/v4/accounts/` +
    `${encodeURIComponent(accountId)}/email/sending/send`;

  return {
    async send(mail) {
      // One deadline for the whole attempt. unref'd so a pending send can
      // never hold the process open during shutdown.
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, CF_EMAIL_TIMEOUT_MS);
      timer.unref();

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from,
            to: mail.to,
            subject: SUBJECT,
            text: textBody(mail.link),
            html: htmlBody(mail.link),
          }),
          signal: controller.signal,
        });
      } catch {
        // The thrown error is NOT logged: only these curated fields leave
        // this function, so nothing derived from the token can escape.
        log.error(
          { kind: mail.kind, timedOut: controller.signal.aborted },
          'cloudflare email send failed',
        );
        throw sendFailed();
      }

      try {
        if (!response.ok) {
          log.error(
            {
              kind: mail.kind,
              status: response.status,
              body: await redactedErrorBody(response, apiToken),
            },
            'cloudflare email send rejected',
          );
          throw sendFailed();
        }
        // Nothing here reads the success body, and an unconsumed body holds
        // the undici connection out of the pool until the Response is
        // finalized. Cancelling returns the socket now.
        await response.body?.cancel().catch(() => undefined);
      } finally {
        // Cleared only once the body is done with, NOT when the headers land.
        // The deadline exists to bound a blocked sign-in request, and reading
        // the error body is inside that request: clearing the timer earlier
        // left `response.text()` with no live signal, so a stalling body hung
        // the sign-in indefinitely against a stated 8s bound.
        clearTimeout(timer);
      }
    },
  };
}

/** Cloudflare's error payload, truncated, with any occurrence of the bearer
 *  token replaced — defence in depth against a body that echoes the request. */
async function redactedErrorBody(response: Response, apiToken: string): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return '<unreadable>';
  }
  // SCRUB FIRST, THEN TRUNCATE. Doing it the other way round cuts the token in
  // half when it straddles the limit, so `split` no longer matches the
  // fragment and the prefix goes to the log verbatim — the redaction silently
  // does nothing in exactly the case it exists for.
  return text.split(apiToken).join('[redacted]').slice(0, CF_ERROR_BODY_MAX);
}

function createSmtpMailer(smtp: AppConfig['smtp'], host: string, log: FastifyBaseLogger): Mailer {
  const transport = nodemailer.createTransport({
    host,
    port: smtp.port,
    secure: smtp.port === 465,
    ...(smtp.user !== null && smtp.pass !== null
      ? { auth: { user: smtp.user, pass: smtp.pass } }
      : {}),
  });

  return {
    async send(mail) {
      try {
        await transport.sendMail({
          from: smtp.from,
          to: mail.to,
          subject: SUBJECT,
          text: textBody(mail.link),
          html: htmlBody(mail.link),
        });
      } catch (err) {
        // nodemailer error text quotes the server dialogue and can carry the
        // configured credentials; only its stable code is logged.
        const code = (err as { code?: unknown }).code;
        log.error(
          { kind: mail.kind, code: typeof code === 'string' ? code : null },
          'smtp email send failed',
        );
        throw sendFailed();
      }
    },
  };
}

export function createMailer(config: AppConfig, log: FastifyBaseLogger): Mailer {
  const { cloudflare, smtp } = config;

  if (cloudflare.emailAccountId !== null && cloudflare.emailApiToken !== null) {
    return createCloudflareMailer(
      cloudflare.emailAccountId,
      cloudflare.emailApiToken,
      cloudflare.emailFrom,
      log,
    );
  }

  if (smtp.host !== null) {
    return createSmtpMailer(smtp, smtp.host, log);
  }

  return {
    async send(mail) {
      log.info(
        { to: mail.to, link: mail.link, kind: mail.kind },
        'magic link (no mailer configured)',
      );
    },
  };
}
