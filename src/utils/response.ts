import { Context } from 'hono';
import crypto from 'crypto';

/**
 * Stripe-style response helpers.
 *
 * Every response includes:
 * - Consistent `object` field identifying the resource type
 * - ETag header for conditional requests
 * - Proper cache headers
 */

export interface ApiObject {
  object: string;
  id: string;
  [key: string]: any;
}

/**
 * Generate an ETag from response data.
 */
export function generateETag(data: any): string {
  const hash = crypto.createHash('md5').update(JSON.stringify(data)).digest('hex');
  return `"${hash}"`;
}

/**
 * Check If-None-Match header and return 304 if matched.
 * Returns true if 304 was sent (caller should stop).
 */
export function handleConditionalRequest(c: Context, etag: string): boolean {
  const ifNoneMatch = c.req.header('if-none-match');
  if (ifNoneMatch === etag) {
    c.status(304);
    c.header('etag', etag);
    return true;
  }
  c.header('etag', etag);
  return false;
}

/**
 * Wrap a single resource in a Stripe-style response.
 */
export function resourceResponse(objectType: string, data: Record<string, any>): Record<string, any> {
  return {
    object: objectType,
    ...data,
  };
}
