/**
 * Magic-link transports: the Cloudflare Email Service REST call, the SMTP
 * fallback, the log-only dev flow, and the failure posture — a non-2xx and a
 * timeout both REJECT (the sign-in request must not answer "check your email"
 * over a send that never happened), and neither the API token nor the
 * provider's raw body ever reaches a log line, an Error, or the caller.
 * Global fetch is stubbed and nodemailer is mocked — no network, no mail.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from '../src/config';
import { AppError } from '../src/lib/errors';
import { CF_EMAIL_TIMEOUT_MS, createMailer } from '../src/modules/auth/email';
import type { MagicLinkMail } from '../src/modules/auth/email';
import { makeApp, testConfig } from './helpers';

const nodemailerMock = vi.hoisted(() => ({
  createTransport: vi.fn<(options: Record<string, unknown>) => unknown>(),
  sendMail: vi.fn<(options: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: nodemailerMock.createTransport },
}));

/** Distinctive so a substring scan over the logs cannot false-negative. */
const CF_TOKEN = 'cf-email-token-must-never-be-logged-4f9a';
const SMTP_PASS = 'smtp-pass-must-never-be-logged-71c3';
const ACCOUNT_ID = 'acct-123';
const SEND_URL = 'https://api.cloudflare.com/client/v4/accounts/acct-123/email/sending/send';
const LINK = 'https://app.test/auth/verify?token=magic-abc';

const MAIL: MagicLinkMail = { to: 'user@example.com', link: LINK, kind: 'magic-link' };

type FetchMock = (input: string | URL, init?: RequestInit) => Promise<Response>;

function stubFetch(impl: FetchMock): ReturnType<typeof vi.fn<FetchMock>> {
  const mock = vi.fn<FetchMock>(impl);
  vi.stubGlobal('fetch', mock);
  return mock;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Recorder {
  log: FastifyBaseLogger;
  /** Every argument handed to the logger, serialized for substring scanning. */
  dump(): string;
  lines: unknown[][];
}

function recordingLogger(): Recorder {
  const lines: unknown[][] = [];
  const record =
    () =>
    (...args: unknown[]): void => {
      lines.push(args);
    };
  const log = {
    info: record(),
    warn: record(),
    error: record(),
    debug: record(),
    trace: record(),
    fatal: record(),
  };
  return {
    log: log as unknown as FastifyBaseLogger,
    lines,
    dump: () => lines.map((args) => args.map((a) => inspect(a)).join(' ')).join('\n'),
  };
}

/** JSON where possible, String() otherwise — pino would serialize either. */
function inspect(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

const SMTP_SETTINGS: AppConfig['smtp'] = {
  host: 'smtp.playin.test',
  port: 587,
  user: 'mailer',
  pass: SMTP_PASS,
  from: 'Playin <no-reply@smtp.test>',
};

function cfConfig(overrides: Partial<AppConfig['cloudflare']> = {}): AppConfig {
  return testConfig({
    cloudflare: {
      emailAccountId: ACCOUNT_ID,
      emailApiToken: CF_TOKEN,
      emailFrom: 'Playin <no-reply@playin.test>',
      ...overrides,
    },
  });
}

function smtpConfig(): AppConfig {
  return testConfig({ smtp: SMTP_SETTINGS });
}

describe('magic-link mailer', () => {
  beforeEach(() => {
    nodemailerMock.createTransport.mockReset();
    nodemailerMock.sendMail.mockReset();
    nodemailerMock.sendMail.mockResolvedValue({ messageId: 'stub' });
    nodemailerMock.createTransport.mockReturnValue({ sendMail: nodemailerMock.sendMail });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('Cloudflare Email Service transport', () => {
    it('POSTs the link to the account send endpoint with a bearer token', async () => {
      const fetchMock = stubFetch(async () => jsonResponse(200, { success: true }));
      const recorder = recordingLogger();

      await createMailer(cfConfig(), recorder.log).send(MAIL);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0]!;
      expect(call[0]).toBe(SEND_URL);
      const init = call[1]!;
      expect(init.method).toBe('POST');

      const headers = init.headers as Record<string, string>;
      expect(headers.authorization).toBe(`Bearer ${CF_TOKEN}`);
      expect(headers['content-type']).toBe('application/json');
      // The token is an Authorization header ONLY — never a query param.
      expect(String(call[0])).not.toContain(CF_TOKEN);

      const body = JSON.parse(String(init.body)) as Record<string, string>;
      expect(body.from).toBe('Playin <no-reply@playin.test>');
      expect(body.to).toBe('user@example.com');
      expect(body.subject).toBe('Your Playin sign-in link');
      expect(body.text).toContain(LINK);
      expect(body.html).toContain(`href="${LINK}"`);

      // A sign-in path never issues an unbounded HTTP call.
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(CF_EMAIL_TIMEOUT_MS).toBeGreaterThan(0);
      expect(CF_EMAIL_TIMEOUT_MS).toBeLessThanOrEqual(15000);

      // Nothing at all is logged on the happy path.
      expect(recorder.lines).toHaveLength(0);
    });

    it('is preferred over a configured SMTP transport', async () => {
      const fetchMock = stubFetch(async () => jsonResponse(200, { success: true }));
      const config = { ...cfConfig(), smtp: smtpConfig().smtp };

      await createMailer(config, recordingLogger().log).send(MAIL);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(nodemailerMock.createTransport).not.toHaveBeenCalled();
    });

    it('rejects on a non-2xx and leaks neither the token nor the raw body', async () => {
      // Worst case: the provider echoes the credential back in its error.
      const providerBody = { success: false, errors: [{ code: 10000, message: CF_TOKEN }] };
      stubFetch(async () => jsonResponse(403, providerBody));
      const recorder = recordingLogger();

      const thrown = await createMailer(cfConfig(), recorder.log).send(MAIL).then(
        () => null,
        (e: unknown) => e,
      );

      expect(thrown).toBeInstanceOf(AppError);
      const err = thrown as AppError;
      expect(err.code).toBe('INTERNAL');
      // The caller learns nothing about the provider exchange.
      expect(err.message).toBe('could not send the sign-in email');
      expect(err.message).not.toContain(CF_TOKEN);
      expect(err.message).not.toContain('403');
      expect(err.stack ?? '').not.toContain(CF_TOKEN);

      // The operator DOES get the status, and a scrubbed body.
      const logged = recorder.dump();
      expect(logged).toContain('403');
      expect(logged).toContain('[redacted]');
      expect(logged).not.toContain(CF_TOKEN);
    });

    it('redacts a token that straddles the truncation boundary', async () => {
      // The scrub and the truncate are NOT commutative. Truncating first cuts
      // the token in half, `split` stops matching the fragment, and the prefix
      // reaches the log — the redaction fails in precisely the case it exists
      // for. The body is built as a raw string so the token lands deliberately
      // ACROSS the 512-char cut: 20 of its characters sit inside it.
      const BODY_MAX = 512; // mirrors CF_ERROR_BODY_MAX in the module
      const straddle = 20;
      const raw = `${'x'.repeat(BODY_MAX - straddle)}${CF_TOKEN}`;
      stubFetch(async () => new Response(raw, { status: 403 }));
      const recorder = recordingLogger();

      await createMailer(cfConfig(), recorder.log)
        .send(MAIL)
        .catch(() => undefined);

      const logged = recorder.dump();
      expect(logged).not.toContain(CF_TOKEN);
      // The real assertion: not even the leading fragment that survives a
      // truncate-then-scrub ordering.
      expect(logged).not.toContain(CF_TOKEN.slice(0, straddle));
    });

    it('gives up at the timeout, rejects, and never retries', async () => {
      vi.useFakeTimers();
      const fetchMock = stubFetch(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          }),
      );
      const recorder = recordingLogger();

      const sending = createMailer(cfConfig(), recorder.log).send(MAIL);
      const rejected = expect(sending).rejects.toThrow('could not send the sign-in email');
      await vi.advanceTimersByTimeAsync(CF_EMAIL_TIMEOUT_MS);
      await rejected;

      // A resend cannot be distinguished from a lost reply — one attempt only,
      // or the user gets two live sign-in links.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // The deadline fired — not some other network error.
      const logged = recorder.dump();
      expect(logged).toContain('"timedOut":true');
      expect(logged).not.toContain(CF_TOKEN);
    });

    it('falls through to SMTP when only one of the two settings is present', async () => {
      const fetchMock = stubFetch(async () => jsonResponse(200, { success: true }));
      const config = {
        ...cfConfig({ emailApiToken: null }),
        smtp: smtpConfig().smtp,
      };

      await createMailer(config, recordingLogger().log).send(MAIL);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(nodemailerMock.sendMail).toHaveBeenCalledTimes(1);
    });
  });

  describe('SMTP fallback', () => {
    it('sends through nodemailer when no Cloudflare config is present', async () => {
      const fetchMock = stubFetch(async () => jsonResponse(200, { success: true }));

      await createMailer(smtpConfig(), recordingLogger().log).send(MAIL);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(nodemailerMock.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'smtp.playin.test',
          port: 587,
          secure: false,
          auth: { user: 'mailer', pass: SMTP_PASS },
        }),
      );
      expect(nodemailerMock.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'Playin <no-reply@smtp.test>',
          to: 'user@example.com',
          subject: 'Your Playin sign-in link',
        }),
      );
    });

    it('rejects on a send failure without logging the SMTP password', async () => {
      const failure = Object.assign(new Error(`535 auth failed for mailer/${SMTP_PASS}`), {
        code: 'EAUTH',
      });
      nodemailerMock.sendMail.mockRejectedValue(failure);
      const recorder = recordingLogger();

      const sending = createMailer(smtpConfig(), recorder.log).send(MAIL);

      await expect(sending).rejects.toThrow('could not send the sign-in email');
      const logged = recorder.dump();
      expect(logged).toContain('EAUTH');
      expect(logged).not.toContain(SMTP_PASS);
    });
  });

  describe('log fallback (the dev sign-in flow)', () => {
    it('logs the link and resolves when no transport is configured', async () => {
      const fetchMock = stubFetch(async () => jsonResponse(200, { success: true }));
      const recorder = recordingLogger();

      await createMailer(testConfig(), recorder.log).send(MAIL);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(nodemailerMock.createTransport).not.toHaveBeenCalled();
      // The link IS the dev credential here — logging it is the point.
      expect(recorder.dump()).toContain(LINK);
    });
  });

  describe('failure posture at the HTTP boundary', () => {
    it('answers POST /auth/magic-link with 500 when the send fails', async () => {
      stubFetch(async () => jsonResponse(500, { errors: [{ message: CF_TOKEN }] }));
      const app = await makeApp(cfConfig());
      try {
        const res = await app.app.inject({
          method: 'POST',
          url: '/auth/magic-link',
          payload: { email: 'stranded@example.com' },
        });

        // A send that failed must NOT read as `{ ok: true }` — the user would
        // wait forever on a mail nobody sent.
        expect(res.statusCode).toBe(500);
        expect((res.json() as { code: string }).code).toBe('INTERNAL');
        expect(res.body).not.toContain(CF_TOKEN);
      } finally {
        await app.app.close();
      }
    });
  });

  it('never writes a configured secret to a log line, on any path', async () => {
    const paths: Array<() => Promise<void>> = [
      async () => {
        stubFetch(async () => jsonResponse(200, { success: true }));
        const recorder = recordingLogger();
        await createMailer(cfConfig(), recorder.log).send(MAIL);
        expect(recorder.dump()).not.toContain(CF_TOKEN);
      },
      async () => {
        stubFetch(async () => jsonResponse(500, { errors: [{ message: CF_TOKEN }] }));
        const recorder = recordingLogger();
        await createMailer(cfConfig(), recorder.log)
          .send(MAIL)
          .catch(() => {});
        expect(recorder.dump()).not.toContain(CF_TOKEN);
      },
      async () => {
        stubFetch(async () => {
          throw new Error(`connect ECONNREFUSED while sending Bearer ${CF_TOKEN}`);
        });
        const recorder = recordingLogger();
        await createMailer(cfConfig(), recorder.log)
          .send(MAIL)
          .catch(() => {});
        expect(recorder.dump()).not.toContain(CF_TOKEN);
      },
      async () => {
        nodemailerMock.sendMail.mockRejectedValue(new Error(`pass=${SMTP_PASS}`));
        const recorder = recordingLogger();
        await createMailer(smtpConfig(), recorder.log)
          .send(MAIL)
          .catch(() => {});
        expect(recorder.dump()).not.toContain(SMTP_PASS);
      },
    ];

    for (const path of paths) {
      await path();
    }
  });
});
