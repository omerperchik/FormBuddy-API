import { Context, Next } from 'hono';
import { query } from '../db/pool.js';

/**
 * Idempotency key middleware — Stripe's signature feature.
 *
 * Clients send `Idempotency-Key: <key>` on POST/PATCH/DELETE requests.
 * If the same key is seen again within 24 hours, the cached response is returned
 * instead of re-executing the request. Prevents double charges, duplicate creates, etc.
 *
 * Keys are scoped to the authenticated user — the same key from different users
 * produces independent results (like Stripe).
 */
export async function idempotency(c: Context, next: Next) {
  // Only apply to mutating methods
  const method = c.req.method;
  if (method === 'GET' || method === 'OPTIONS' || method === 'HEAD') {
    return next();
  }

  const idempotencyKey = c.req.header('idempotency-key');
  if (!idempotencyKey) {
    return next();
  }

  // Validate key format (max 255 chars, printable ASCII)
  if (idempotencyKey.length > 255 || !/^[\x20-\x7E]+$/.test(idempotencyKey)) {
    return c.json({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_idempotency_key',
        message: 'Idempotency key must be 1-255 printable ASCII characters.',
      },
    }, 400);
  }

  const userId = c.get('userId') || 'anonymous';
  const scopedKey = `${userId}:${idempotencyKey}`;

  // Check for existing response
  try {
    const existing = await query(
      `SELECT response_status, response_body, request_path, request_method
       FROM idempotency_keys
       WHERE key_hash = $1 AND expires_at > NOW()`,
      [scopedKey]
    );

    if (existing.rows.length > 0) {
      const cached = existing.rows[0];

      // Stripe behavior: if same key used with different path/method, error
      const currentPath = new URL(c.req.url).pathname;
      if (cached.request_path !== currentPath || cached.request_method !== method) {
        return c.json({
          error: {
            type: 'invalid_request_error',
            code: 'idempotency_key_reuse',
            message: `This idempotency key was already used with ${cached.request_method} ${cached.request_path}. Use a different key for this request.`,
          },
        }, 422);
      }

      c.header('idempotent-replayed', 'true');
      return c.json(JSON.parse(cached.response_body), cached.response_status);
    }
  } catch {
    // Table might not exist yet — skip idempotency gracefully
    return next();
  }

  // Execute the request
  await next();

  // Cache the response (fire-and-forget)
  try {
    const body = await c.res.clone().text();
    const currentPath = new URL(c.req.url).pathname;
    await query(
      `INSERT INTO idempotency_keys (key_hash, request_path, request_method, response_status, response_body, expires_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '24 hours')
       ON CONFLICT (key_hash) DO NOTHING`,
      [scopedKey, currentPath, method, c.res.status, body]
    );
  } catch {
    // Non-critical — don't fail the request
  }
}
