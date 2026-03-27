import { Context, Next } from 'hono';
import jwt from 'jsonwebtoken';
import type { JWTPayload } from '../types.js';

declare module 'hono' {
  interface ContextVariableMap {
    userId: string;
    userEmail: string;
    userTier: string;
  }
}

export async function authMiddleware(c: Context, next: Next) {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as JWTPayload;
    c.set('userId', payload.sub);
    c.set('userEmail', payload.email);
    c.set('userTier', payload.tier);
    return next();
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
}

export function requireTier(...tiers: string[]) {
  return async (c: Context, next: Next) => {
    const userTier = c.get('userTier');
    if (!tiers.includes(userTier)) {
      return c.json({ error: 'Upgrade required', required_tier: tiers[0] }, 403);
    }
    return next();
  };
}
