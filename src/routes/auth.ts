import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { authMiddleware } from '../middleware/auth.js';
import { audit, auditContext } from '../services/audit.js';
import type { JWTPayload } from '../types.js';

const auth = new Hono();

const registerSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  name: z.string().max(100).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
  device: z.string().max(255).optional(),
});

function generateTokens(user: { id: string; email: string; tier: string }) {
  const payload: JWTPayload = { sub: user.id, email: user.email, tier: user.tier };

  const accessToken = jwt.sign(payload, process.env.JWT_SECRET!, {
    expiresIn: (process.env.JWT_EXPIRY || '15m') as any,
  });

  const refreshToken = crypto.randomBytes(48).toString('hex');

  return { accessToken, refreshToken };
}

// POST /api/auth/register
auth.post('/register', async (c) => {
  const body = await c.req.json();
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: {
        type: 'invalid_request_error',
        code: 'validation_error',
        message: 'Invalid request parameters.',
        details: parsed.error.flatten(),
      },
    }, 400);
  }

  const { email, password, name } = parsed.data;

  const existing = await query('SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL', [email]);
  if (existing.rows.length > 0) {
    return c.json({
      error: {
        type: 'invalid_request_error',
        code: 'email_exists',
        message: 'An account with this email already exists.',
        param: 'email',
      },
    }, 409);
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const result = await query(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3)
     RETURNING id, email, name, tier, created_at`,
    [email, passwordHash, name || null]
  );
  const user = result.rows[0];

  // Create default profile
  await query(
    `INSERT INTO profiles (user_id, name, type, is_default) VALUES ($1, 'Personal', 'personal', true)`,
    [user.id]
  );

  const { accessToken, refreshToken } = generateTokens(user);

  // Store refresh token with prefix for O(1) lookup
  const tokenPrefix = refreshToken.slice(0, 8);
  const refreshHash = await bcrypt.hash(refreshToken, 10);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await query(
    `INSERT INTO refresh_tokens (user_id, token_prefix, token_hash, expires_at) VALUES ($1, $2, $3, $4)`,
    [user.id, tokenPrefix, refreshHash, expiresAt]
  );

  audit({
    user_id: user.id,
    action: 'register',
    resource_type: 'user',
    resource_id: user.id,
    request_id: c.get('requestId'),
    ip_address: c.req.header('x-forwarded-for'),
  });

  return c.json({
    object: 'auth_session',
    user: {
      object: 'user',
      id: user.id,
      email: user.email,
      name: user.name,
      tier: user.tier,
      created_at: user.created_at,
    },
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: process.env.JWT_EXPIRY || '15m',
  }, 201);
});

// POST /api/auth/login
auth.post('/login', async (c) => {
  const body = await c.req.json();
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: {
        type: 'invalid_request_error',
        code: 'validation_error',
        message: 'Invalid request parameters.',
        details: parsed.error.flatten(),
      },
    }, 400);
  }

  const { email, password, device } = parsed.data;

  const result = await query(
    'SELECT id, email, password_hash, name, tier FROM users WHERE email = $1 AND deleted_at IS NULL',
    [email]
  );
  if (result.rows.length === 0) {
    return c.json({
      error: {
        type: 'authentication_error',
        code: 'invalid_credentials',
        message: 'No account found with these credentials.',
      },
    }, 401);
  }

  const user = result.rows[0];
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return c.json({
      error: {
        type: 'authentication_error',
        code: 'invalid_credentials',
        message: 'No account found with these credentials.',
      },
    }, 401);
  }

  const { accessToken, refreshToken } = generateTokens(user);

  const tokenPrefix = refreshToken.slice(0, 8);
  const refreshHash = await bcrypt.hash(refreshToken, 10);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await query(
    `INSERT INTO refresh_tokens (user_id, token_prefix, token_hash, device, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [user.id, tokenPrefix, refreshHash, device || null, expiresAt]
  );

  audit({
    user_id: user.id,
    action: 'login',
    resource_type: 'user',
    resource_id: user.id,
    request_id: c.get('requestId'),
    ip_address: c.req.header('x-forwarded-for'),
  });

  return c.json({
    object: 'auth_session',
    user: {
      object: 'user',
      id: user.id,
      email: user.email,
      name: user.name,
      tier: user.tier,
    },
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: process.env.JWT_EXPIRY || '15m',
  });
});

// POST /api/auth/refresh — O(1) token lookup via prefix
auth.post('/refresh', async (c) => {
  const { refresh_token } = await c.req.json();
  if (!refresh_token || typeof refresh_token !== 'string') {
    return c.json({
      error: {
        type: 'invalid_request_error',
        code: 'missing_parameter',
        message: 'refresh_token is required.',
        param: 'refresh_token',
      },
    }, 400);
  }

  // O(1) lookup using token prefix instead of scanning all tokens
  const tokenPrefix = refresh_token.slice(0, 8);
  const candidates = await query(
    'SELECT id, user_id, token_hash FROM refresh_tokens WHERE token_prefix = $1 AND expires_at > NOW()',
    [tokenPrefix]
  );

  let matchedToken: { id: string; user_id: string } | null = null;
  for (const t of candidates.rows) {
    if (await bcrypt.compare(refresh_token, t.token_hash)) {
      matchedToken = t;
      break;
    }
  }

  if (!matchedToken) {
    return c.json({
      error: {
        type: 'authentication_error',
        code: 'invalid_refresh_token',
        message: 'Refresh token is invalid or expired.',
      },
    }, 401);
  }

  // Token rotation — delete used token
  await query('DELETE FROM refresh_tokens WHERE id = $1', [matchedToken.id]);

  const userResult = await query(
    'SELECT id, email, name, tier FROM users WHERE id = $1 AND deleted_at IS NULL',
    [matchedToken.user_id]
  );
  if (userResult.rows.length === 0) {
    return c.json({
      error: { type: 'authentication_error', code: 'user_not_found', message: 'User account not found.' },
    }, 401);
  }

  const user = userResult.rows[0];
  const { accessToken, refreshToken: newRefreshToken } = generateTokens(user);

  const newPrefix = newRefreshToken.slice(0, 8);
  const refreshHash = await bcrypt.hash(newRefreshToken, 10);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await query(
    `INSERT INTO refresh_tokens (user_id, token_prefix, token_hash, expires_at) VALUES ($1, $2, $3, $4)`,
    [user.id, newPrefix, refreshHash, expiresAt]
  );

  return c.json({
    object: 'auth_session',
    access_token: accessToken,
    refresh_token: newRefreshToken,
    expires_in: process.env.JWT_EXPIRY || '15m',
  });
});

// POST /api/auth/logout
auth.post('/logout', authMiddleware, async (c) => {
  const userId = c.get('userId');
  await query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);

  audit({ ...auditContext(c), action: 'logout', resource_type: 'user', resource_id: userId, user_id: userId });

  return c.json({ object: 'confirmation', message: 'All sessions revoked.' });
});

// GET /api/auth/me
auth.get('/me', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const result = await query(
    'SELECT id, email, name, avatar_url, tier, created_at, updated_at FROM users WHERE id = $1 AND deleted_at IS NULL',
    [userId]
  );
  if (result.rows.length === 0) {
    return c.json({
      error: { type: 'invalid_request_error', code: 'resource_not_found', message: 'User not found.' },
    }, 404);
  }

  const user = result.rows[0];
  return c.json({
    object: 'user',
    ...user,
  });
});

export default auth;
