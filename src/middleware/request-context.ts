import { Context, Next } from 'hono';
import crypto from 'crypto';

declare module 'hono' {
  interface ContextVariableMap {
    requestId: string;
    apiVersion: string;
    requestStartTime: number;
  }
}

/**
 * Attaches a unique request ID, API version, and timing to every request.
 * Mirrors Stripe's x-request-id pattern for traceability.
 */
export async function requestContext(c: Context, next: Next) {
  const requestId = c.req.header('x-request-id') || `req_${crypto.randomBytes(16).toString('hex')}`;
  const apiVersion = c.req.header('formbuddy-version') || '2026-03-28';

  c.set('requestId', requestId);
  c.set('apiVersion', apiVersion);
  c.set('requestStartTime', Date.now());

  c.header('x-request-id', requestId);
  c.header('formbuddy-version', apiVersion);

  await next();

  // Timing header
  const duration = Date.now() - c.get('requestStartTime');
  c.header('x-response-time', `${duration}ms`);
}
