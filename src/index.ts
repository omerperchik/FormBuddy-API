import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Server } from 'http';

import { requestContext } from './middleware/request-context.js';
import { idempotency } from './middleware/idempotency.js';
import { rateLimit } from './middleware/rate-limit.js';

import auth from './routes/auth.js';
import profiles from './routes/profiles.js';
import fields from './routes/fields.js';
import sync from './routes/sync.js';
import templates from './routes/templates.js';
import history from './routes/history.js';
import billing from './routes/billing.js';
import apiKeys from './routes/api-keys.js';
import webhooks from './routes/webhooks.js';
import events from './routes/events.js';
import batch from './routes/batch.js';

import pool from './db/pool.js';
import { AppError } from './utils/errors.js';

const app = new Hono();

// ============================================================
// GLOBAL MIDDLEWARE (order matters)
// ============================================================

// 1. Request ID + API versioning + timing
app.use('*', requestContext);

// 2. CORS
app.use('*', cors({
  origin: (origin) => {
    const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim());
    if (!origin || allowed.includes(origin) || process.env.NODE_ENV === 'development') {
      return origin || '*';
    }
    return '';
  },
  allowHeaders: ['Authorization', 'Content-Type', 'X-Device-Id', 'Idempotency-Key', 'If-None-Match', 'FormBuddy-Version'],
  exposeHeaders: ['X-Request-Id', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset',
                   'X-Response-Time', 'ETag', 'Idempotent-Replayed', 'FormBuddy-Version', 'Retry-After'],
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  maxAge: 86400,
}));

// 3. Global rate limit: 200 req/min
app.use('/api/*', rateLimit(200, 60_000));

// 4. Idempotency for mutations
app.use('/api/*', idempotency);

// 5. Stricter rate limits on auth
app.use('/api/auth/login', rateLimit(10, 60_000));
app.use('/api/auth/register', rateLimit(5, 60_000));

// ============================================================
// ROUTES
// ============================================================
app.route('/api/auth', auth);
app.route('/api/profiles', profiles);
app.route('/api/fields', fields);
app.route('/api/sync', sync);
app.route('/api/templates', templates);
app.route('/api/history', history);
app.route('/api/billing', billing);
app.route('/api/api-keys', apiKeys);
app.route('/api/webhooks', webhooks);
app.route('/api/events', events);
app.route('/api/batch', batch);

// ============================================================
// HEALTH CHECK — comprehensive, like Stripe
// ============================================================
app.get('/health', async (c) => {
  const checks: Record<string, { status: string; latency_ms?: number }> = {};

  // Database check
  try {
    const start = Date.now();
    await pool.query('SELECT 1');
    checks.database = { status: 'healthy', latency_ms: Date.now() - start };
  } catch {
    checks.database = { status: 'unhealthy' };
  }

  const allHealthy = Object.values(checks).every((c) => c.status === 'healthy');

  return c.json({
    status: allHealthy ? 'healthy' : 'degraded',
    version: '2.0.0',
    checks,
    uptime_seconds: Math.floor(process.uptime()),
  }, allHealthy ? 200 : 503);
});

// Liveness probe (lightweight)
app.get('/health/live', (c) => c.json({ status: 'ok' }));

// ============================================================
// ERROR HANDLER — Stripe-style structured errors
// ============================================================
app.onError((err, c) => {
  const requestId = c.get('requestId');

  if (err instanceof AppError) {
    return c.json({
      error: err.body,
      request_id: requestId,
    }, err.statusCode as any);
  }

  // Unexpected errors — log but don't leak internals
  console.error(`[Error] [${requestId}]`, err);
  return c.json({
    error: {
      type: 'api_error',
      code: 'internal_error',
      message: 'An unexpected error occurred. If this persists, contact support with the request ID.',
    },
    request_id: requestId,
  }, 500);
});

// ============================================================
// 404
// ============================================================
app.notFound((c) => {
  return c.json({
    error: {
      type: 'invalid_request_error',
      code: 'route_not_found',
      message: `No such route: ${c.req.method} ${new URL(c.req.url).pathname}. Check the API reference.`,
    },
    request_id: c.get('requestId'),
  }, 404);
});

// ============================================================
// START + GRACEFUL SHUTDOWN
// ============================================================
const port = parseInt(process.env.PORT || '3500');
let server: Server;

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`FormBuddy API v2.0.0 running on http://localhost:${info.port}`);
  server = info as any;
});

// Graceful shutdown — drain connections, close DB pool
async function shutdown(signal: string) {
  console.log(`\n[${signal}] Shutting down gracefully...`);

  // Stop accepting new connections
  if (server) {
    server.close(() => {
      console.log('[Shutdown] HTTP server closed');
    });
  }

  // Close database pool
  try {
    await pool.end();
    console.log('[Shutdown] Database pool closed');
  } catch (err) {
    console.error('[Shutdown] Error closing DB pool:', err);
  }

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
