import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import auth from './routes/auth.js';
import profiles from './routes/profiles.js';
import fields from './routes/fields.js';
import sync from './routes/sync.js';
import templates from './routes/templates.js';
import history from './routes/history.js';
import billing from './routes/billing.js';
import { rateLimit } from './middleware/rate-limit.js';
import { AppError } from './utils/errors.js';

const app = new Hono();

// ---- Global middleware ----
app.use('*', logger());

app.use('*', cors({
  origin: (origin) => {
    const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim());
    if (!origin || allowed.includes(origin) || process.env.NODE_ENV === 'development') {
      return origin || '*';
    }
    return '';
  },
  allowHeaders: ['Authorization', 'Content-Type', 'X-Device-Id'],
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  maxAge: 86400,
}));

// Rate limit: 100 requests per minute globally
app.use('/api/*', rateLimit(100, 60_000));

// Stricter rate limit on auth endpoints
app.use('/api/auth/login', rateLimit(10, 60_000));
app.use('/api/auth/register', rateLimit(5, 60_000));

// ---- Routes ----
app.route('/api/auth', auth);
app.route('/api/profiles', profiles);
app.route('/api/fields', fields);
app.route('/api/sync', sync);
app.route('/api/templates', templates);
app.route('/api/history', history);
app.route('/api/billing', billing);

// ---- Health check ----
app.get('/health', (c) => c.json({ status: 'ok', version: '1.0.0' }));

// ---- Error handler ----
app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json({ error: err.message, code: err.code }, err.statusCode as any);
  }
  console.error('[Error]', err);
  return c.json({ error: 'Internal server error' }, 500);
});

// ---- 404 ----
app.notFound((c) => c.json({ error: 'Not found' }, 404));

// ---- Start ----
const port = parseInt(process.env.PORT || '3500');

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`FormBuddy API running on http://localhost:${info.port}`);
});

export default app;
