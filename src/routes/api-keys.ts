import { Hono } from 'hono';
import { z } from 'zod';
import crypto from 'crypto';
import { query } from '../db/pool.js';
import { authMiddleware } from '../middleware/auth.js';
import { generateApiKey, hashApiKey, ALL_SCOPES } from '../middleware/api-key-auth.js';
import { emitEvent } from '../services/webhooks.js';
import { audit, auditContext } from '../services/audit.js';

const apiKeys = new Hono();
apiKeys.use('*', authMiddleware);

const createKeySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.string()).default(['*']),
  is_test_mode: z.boolean().default(false),
});

// GET /api/api-keys — list all API keys (shows prefix, never the full key)
apiKeys.get('/', async (c) => {
  const userId = c.get('userId');
  const result = await query(
    `SELECT id, name, key_prefix, scopes, is_test_mode, last_used_at, revoked_at, created_at
     FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );

  return c.json({
    object: 'list',
    data: result.rows.map((k) => ({
      object: 'api_key',
      ...k,
      status: k.revoked_at ? 'revoked' : 'active',
    })),
  });
});

// POST /api/api-keys — create a new API key (returns full key ONCE)
apiKeys.post('/', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  const parsed = createKeySchema.safeParse(body);
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

  const { name, scopes, is_test_mode } = parsed.data;

  // Validate scopes
  for (const scope of scopes) {
    if (scope !== '*' && !ALL_SCOPES.includes(scope as any)) {
      return c.json({
        error: {
          type: 'invalid_request_error',
          code: 'invalid_scope',
          message: `Invalid scope '${scope}'. Valid scopes: ${ALL_SCOPES.join(', ')}, *`,
          param: 'scopes',
        },
      }, 400);
    }
  }

  // Pro tier required for API keys
  const tier = c.get('userTier');
  if (tier === 'free') {
    return c.json({
      error: {
        type: 'authorization_error',
        code: 'tier_required',
        message: 'API keys require the Pro plan.',
      },
    }, 403);
  }

  // Max 10 active keys
  const countResult = await query(
    'SELECT COUNT(*)::int FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL',
    [userId]
  );
  if (countResult.rows[0].count >= 10) {
    return c.json({
      error: {
        type: 'invalid_request_error',
        code: 'key_limit_reached',
        message: 'Maximum of 10 active API keys. Revoke an existing key first.',
      },
    }, 400);
  }

  const rawKey = generateApiKey(is_test_mode);
  const keyHash = hashApiKey(rawKey);
  const keyPrefix = rawKey.slice(0, 12) + '...';

  const result = await query(
    `INSERT INTO api_keys (user_id, name, key_hash, key_prefix, scopes, is_test_mode)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, key_prefix, scopes, is_test_mode, created_at`,
    [userId, name, keyHash, keyPrefix, scopes, is_test_mode]
  );

  emitEvent('api_key.created', userId, { key_id: result.rows[0].id, name }, { requestId: c.get('requestId') });
  audit({
    ...auditContext(c), action: 'create_api_key', resource_type: 'api_key',
    resource_id: result.rows[0].id, user_id: userId,
  });

  return c.json({
    object: 'api_key',
    ...result.rows[0],
    key: rawKey,  // ⚠️ Only shown once — client must store it
    _warning: 'Store this key securely. It will not be shown again.',
  }, 201);
});

// DELETE /api/api-keys/:id — revoke a key
apiKeys.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const keyId = c.req.param('id');

  const result = await query(
    'UPDATE api_keys SET revoked_at = NOW() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id',
    [keyId, userId]
  );

  if (result.rows.length === 0) {
    return c.json({
      error: { type: 'invalid_request_error', code: 'resource_not_found', message: 'API key not found or already revoked.' },
    }, 404);
  }

  emitEvent('api_key.revoked', userId, { key_id: keyId }, { requestId: c.get('requestId') });
  audit({
    ...auditContext(c), action: 'revoke_api_key', resource_type: 'api_key',
    resource_id: keyId, user_id: userId,
  });

  return c.json({ object: 'api_key', id: keyId, revoked: true });
});

export default apiKeys;
