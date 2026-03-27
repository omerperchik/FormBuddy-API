import { Context, Next } from 'hono';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.resetAt < now) store.delete(key);
  }
}, 5 * 60 * 1000).unref();

/**
 * Stripe-style rate limiting with proper headers.
 *
 * Returns 429 with:
 * - Retry-After header (seconds until reset)
 * - X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
 * - Structured error body
 */
export function rateLimit(maxRequests: number, windowMs: number) {
  return async (c: Context, next: Next) => {
    // Use user ID if authenticated, otherwise IP
    const userId = c.get('userId');
    const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
    const key = `${userId || ip}:${c.req.routePath || c.req.path}`;
    const now = Date.now();
    const entry = store.get(key);

    if (!entry || entry.resetAt < now) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      c.header('X-RateLimit-Limit', String(maxRequests));
      c.header('X-RateLimit-Remaining', String(maxRequests - 1));
      c.header('X-RateLimit-Reset', String(Math.ceil((now + windowMs) / 1000)));
      return next();
    }

    entry.count++;
    const remaining = Math.max(0, maxRequests - entry.count);
    const resetSeconds = Math.ceil((entry.resetAt - now) / 1000);

    c.header('X-RateLimit-Limit', String(maxRequests));
    c.header('X-RateLimit-Remaining', String(remaining));
    c.header('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > maxRequests) {
      c.header('Retry-After', String(resetSeconds));
      return c.json({
        error: {
          type: 'rate_limit_error',
          code: 'rate_limit_exceeded',
          message: `Rate limit exceeded. Retry after ${resetSeconds} seconds.`,
        },
      }, 429);
    }

    return next();
  };
}
