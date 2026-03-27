import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { authMiddleware } from '../middleware/auth.js';
import type { JWTPayload } from '../types.js';

const auth = new Hono();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
  device: z.string().optional(),
});

function generateTokens(user: { id: string; email: string; tier: string }, device?: string) {
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
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const { email, password, name } = parsed.data;

  // Check existing
  const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    return c.json({ error: 'Email already registered' }, 409);
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const result = await query(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name, tier, created_at`,
    [email, passwordHash, name || null]
  );
  const user = result.rows[0];

  // Create default profile
  await query(
    `INSERT INTO profiles (user_id, name, type, is_default) VALUES ($1, 'Personal', 'personal', true)`,
    [user.id]
  );

  const { accessToken, refreshToken } = generateTokens(user);

  // Store refresh token
  const refreshHash = await bcrypt.hash(refreshToken, 10);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [user.id, refreshHash, expiresAt]
  );

  return c.json({
    user: { id: user.id, email: user.email, name: user.name, tier: user.tier },
    access_token: accessToken,
    refresh_token: refreshToken,
  }, 201);
});

// POST /api/auth/login
auth.post('/login', async (c) => {
  const body = await c.req.json();
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const { email, password, device } = parsed.data;

  const result = await query(
    'SELECT id, email, password_hash, name, tier FROM users WHERE email = $1',
    [email]
  );
  if (result.rows.length === 0) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const user = result.rows[0];
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const { accessToken, refreshToken } = generateTokens(user, device);

  const refreshHash = await bcrypt.hash(refreshToken, 10);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, device, expires_at) VALUES ($1, $2, $3, $4)`,
    [user.id, refreshHash, device || null, expiresAt]
  );

  return c.json({
    user: { id: user.id, email: user.email, name: user.name, tier: user.tier },
    access_token: accessToken,
    refresh_token: refreshToken,
  });
});

// POST /api/auth/refresh
auth.post('/refresh', async (c) => {
  const { refresh_token } = await c.req.json();
  if (!refresh_token) {
    return c.json({ error: 'Refresh token required' }, 400);
  }

  // Find all non-expired refresh tokens and verify
  const tokens = await query(
    'SELECT id, user_id, token_hash FROM refresh_tokens WHERE expires_at > NOW()',
    []
  );

  let matchedToken: { id: string; user_id: string } | null = null;
  for (const t of tokens.rows) {
    if (await bcrypt.compare(refresh_token, t.token_hash)) {
      matchedToken = t;
      break;
    }
  }

  if (!matchedToken) {
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  // Delete used token (rotation)
  await query('DELETE FROM refresh_tokens WHERE id = $1', [matchedToken.id]);

  // Get user
  const userResult = await query(
    'SELECT id, email, name, tier FROM users WHERE id = $1',
    [matchedToken.user_id]
  );
  if (userResult.rows.length === 0) {
    return c.json({ error: 'User not found' }, 401);
  }

  const user = userResult.rows[0];
  const { accessToken, refreshToken: newRefreshToken } = generateTokens(user);

  const refreshHash = await bcrypt.hash(newRefreshToken, 10);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [user.id, refreshHash, expiresAt]
  );

  return c.json({
    access_token: accessToken,
    refresh_token: newRefreshToken,
  });
});

// POST /api/auth/logout
auth.post('/logout', authMiddleware, async (c) => {
  const userId = c.get('userId');
  await query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
  return c.json({ ok: true });
});

// GET /api/auth/me
auth.get('/me', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const result = await query(
    'SELECT id, email, name, avatar_url, tier, created_at FROM users WHERE id = $1',
    [userId]
  );
  if (result.rows.length === 0) {
    return c.json({ error: 'User not found' }, 404);
  }
  return c.json({ user: result.rows[0] });
});

export default auth;
