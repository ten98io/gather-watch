/**
 * Magic-link delivery. With SMTP configured the mail goes out via nodemailer;
 * without it the link is logged — the dev flow — and never an error.
 */
import nodemailer from 'nodemailer';
import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from '../../config';

export interface MagicLinkMail {
  to: string;
  link: string;
  kind: 'magic-link' | 'guest-upgrade';
}

export function createMailer(
  config: AppConfig,
  log: FastifyBaseLogger,
): { send(mail: MagicLinkMail): Promise<void> } {
  const { smtp } = config;

  if (smtp.host === null) {
    return {
      async send(mail) {
        log.info({ to: mail.to, link: mail.link, kind: mail.kind }, 'magic link (no SMTP configured)');
      },
    };
  }

  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    ...(smtp.user !== null && smtp.pass !== null
      ? { auth: { user: smtp.user, pass: smtp.pass } }
      : {}),
  });

  return {
    async send(mail) {
      await transport.sendMail({
        from: smtp.from,
        to: mail.to,
        subject: 'Your Playin sign-in link',
        text: `Sign in to Playin: ${mail.link}`,
        html: `<p>Sign in to Playin: <a href="${mail.link}">${mail.link}</a></p>`,
      });
    },
  };
}
