import { Context, Next } from 'hono';
import crypto from 'crypto';
import { query } from '../db/pool.js';

/**
 * API Key authentication for server-to-server integrations.
 *
 * Supports two auth modes (like Stripe):
 * 1. Bearer JWT token (existing) — for client apps
 * 2. API key via `Authorization: Bearer fb_live_...` — for server integrations
 *
 * API keys are prefixed:
 * - fb_live_*  — production keys
 * - fb_test_*  — test mode keys (sandboxed data)
 *
 * Keys are scoped with permissions: profiles:read, profiles:write, sync, classify, etc.
 */

export interface ApiKeyScope {
  userId: string;
  keyId: string;
  name: string;
  scopes: string[];
  isTestMode: boolean;
}

const ALL_SCOPES = [
  'profiles:read',
  'profiles:write',
  'sync:read',
  'sync:write',
  'templates:read',
  'templates:write',
  'history:read',
  'history:write',
  'classify',
] as const;

export type Scope = typeof ALL_SCOPES[number];

declare module 'hono' {
  interface ContextVariableMap {
    apiKey: ApiKeyScope | null;
  }
}

function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export async function apiKeyAuth(c: Context, next: Next) {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer fb_')) {
    c.set('apiKey', null);
    return next();
  }

  const apiKey = header.slice(7);
  const isTestMode = apiKey.startsWith('fb_test_');
  const keyHash = hashApiKey(apiKey);

  try {
    const result = await query(
      `SELECT ak.id, ak.user_id, ak.name, ak.scopes, ak.is_test_mode, u.tier, u.email
       FROM api_keys ak
       JOIN users u ON u.id = ak.user_id
       WHERE ak.key_hash = $1 AND ak.revoked_at IS NULL`,
      [keyHash]
    );

    if (result.rows.length === 0) {
      return c.json({
        error: {
          type: 'authentication_error',
          code: 'api_key_invalid',
          message: 'Invalid API key provided.',
        },
      }, 401);
    }

    const row = result.rows[0];

    // Update last_used_at (fire-and-forget)
    query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [row.id]).catch(() => {});

    // Set auth context (same as JWT auth)
    c.set('userId', row.user_id);
    c.set('userEmail', row.email);
    c.set('userTier', row.tier);
    c.set('apiKey', {
      userId: row.user_id,
      keyId: row.id,
      name: row.name,
      scopes: row.scopes,
      isTestMode: row.is_test_mode,
    });

    return next();
  } catch {
    return c.json({
      error: {
        type: 'api_error',
        message: 'Failed to validate API key.',
      },
    }, 500);
  }
}

/**
 * Middleware to require a specific scope on an API key.
 * JWT-authed requests bypass scope checks (they have full access).
 */
export function requireScope(scope: Scope) {
  return async (c: Context, next: Next) => {
    const apiKey = c.get('apiKey');
    if (!apiKey) {
      // Not API key auth — either JWT or unauthenticated, let other middleware handle
      return next();
    }

    if (!apiKey.scopes.includes(scope) && !apiKey.scopes.includes('*')) {
      return c.json({
        error: {
          type: 'authorization_error',
          code: 'insufficient_scope',
          message: `This API key does not have the '${scope}' scope. Update the key's permissions or use a key with the required scope.`,
          required_scope: scope,
        },
      }, 403);
    }

    return next();
  };
}

/**
 * Generate a new API key. Returns the raw key (shown once) and stores the hash.
 */
export function generateApiKey(testMode: boolean): string {
  const prefix = testMode ? 'fb_test_' : 'fb_live_';
  const random = crypto.randomBytes(32).toString('base64url');
  return `${prefix}${random}`;
}

export { hashApiKey, ALL_SCOPES };
