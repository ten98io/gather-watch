/**
 * Central error mapping (same conventions as services/api): AppError → its
 * contracts payload at the mapped status; ZodError → 400 VALIDATION; anything
 * else is logged and answered with an opaque 500.
 */
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError, ERROR_STATUS } from '../lib/errors';

/** First zod issue rendered as "path.to.field: message". */
function firstIssueMessage(err: ZodError): string {
  const issue = err.issues[0];
  if (issue === undefined) return 'invalid request';
  const path = issue.path.join('.');
  return path === '' ? issue.message : `${path}: ${issue.message}`;
}

/**
 * Validate a body/query/params value with a zod schema, rethrowing ZodError
 * as AppError('VALIDATION') so routes get a readable 400 for free.
 */
export function parseWith<T>(schema: { parse(v: unknown): T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new AppError('VALIDATION', firstIssueMessage(err));
    }
    throw err;
  }
}

export function registerErrorMapper(app: FastifyInstance): void {
  app.setErrorHandler((err, request, reply) => {
    if (err instanceof AppError) {
      return reply.status(ERROR_STATUS[err.code]).send(err.toPayload());
    }
    if (err instanceof ZodError) {
      return reply
        .status(400)
        .send({ code: 'VALIDATION', message: firstIssueMessage(err) });
    }
    const statusCode = (err as { statusCode?: unknown }).statusCode;
    if (statusCode === 400) {
      return reply.status(400).send({ code: 'VALIDATION', message: 'invalid request body' });
    }
    request.log.error({ err }, 'unhandled request error');
    return reply.status(500).send({ code: 'INTERNAL', message: 'internal error' });
  });

  app.setNotFoundHandler((request, reply) => {
    void request;
    return reply.status(404).send({ code: 'NOT_FOUND', message: 'not found' });
  });
}
