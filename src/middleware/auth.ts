import { Context, Next } from 'hono';
import jwt from 'jsonwebtoken';
import type { JWTPayload } from '../types.js';
import { apiKeyAuth } from './api-key-auth.js';

declare module 'hono' {
  interface ContextVariableMap {
    userId: string;
    userEmail: string;
    userTier: string;
  }
}

/**
 * Unified auth middleware — supports both JWT tokens and API keys.
 *
 * Priority:
 * 1. API key (fb_live_* / fb_test_*) → validated via api_keys table
 * 2. JWT Bearer token → validated via jsonwebtoken
 */
export async function authMiddleware(c: Context, next: Next) {
  const header = c.req.header('Authorization');

  if (!header?.startsWith('Bearer ')) {
    return c.json({
      error: {
        type: 'authentication_error',
        code: 'missing_auth',
        message: 'Missing Authorization header. Use `Bearer <token>` or `Bearer fb_live_<key>`.',
      },
    }, 401);
  }

  const token = header.slice(7);

  // API key auth
  if (token.startsWith('fb_')) {
    return apiKeyAuth(c, next);
  }

  // JWT auth
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as JWTPayload;
    c.set('userId', payload.sub);
    c.set('userEmail', payload.email);
    c.set('userTier', payload.tier);
    return next();
  } catch {
    return c.json({
      error: {
        type: 'authentication_error',
        code: 'token_expired',
        message: 'Your access token has expired. Use /api/auth/refresh to get a new one.',
      },
    }, 401);
  }
}

export function requireTier(...tiers: string[]) {
  return async (c: Context, next: Next) => {
    const userTier = c.get('userTier');
    if (!tiers.includes(userTier)) {
      return c.json({
        error: {
          type: 'authorization_error',
          code: 'tier_required',
          message: `This feature requires the '${tiers[0]}' plan. Upgrade at /api/billing/checkout.`,
          required_tier: tiers[0],
        },
      }, 403);
    }
    return next();
  };
}
