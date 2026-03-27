import { Hono } from 'hono';
import { z } from 'zod';
import crypto from 'crypto';
import { query } from '../db/pool.js';
import { authMiddleware, requireTier } from '../middleware/auth.js';
import { audit, auditContext } from '../services/audit.js';

const webhooks = new Hono();
webhooks.use('*', authMiddleware);

const createEndpointSchema = z.object({
  url: z.string().url().max(2000),
  description: z.string().max(500).optional(),
  event_types: z.array(z.string()).default(['*']),
});

// GET /api/webhooks — list webhook endpoints
webhooks.get('/', async (c) => {
  const userId = c.get('userId');
  const result = await query(
    `SELECT id, url, description, event_types, status, created_at
     FROM webhook_endpoints WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );

  return c.json({
    object: 'list',
    data: result.rows.map((w) => ({ object: 'webhook_endpoint', ...w })),
  });
});

// POST /api/webhooks — register a webhook endpoint
webhooks.post('/', requireTier('pro', 'team'), async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  const parsed = createEndpointSchema.safeParse(body);
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

  const { url, description, event_types } = parsed.data;
  const secret = `whsec_${crypto.randomBytes(24).toString('hex')}`;

  const result = await query(
    `INSERT INTO webhook_endpoints (user_id, url, secret, description, event_types)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, url, description, event_types, status, created_at`,
    [userId, url, secret, description || null, event_types]
  );

  audit({
    ...auditContext(c), action: 'create_webhook', resource_type: 'webhook_endpoint',
    resource_id: result.rows[0].id, user_id: userId,
  });

  return c.json({
    object: 'webhook_endpoint',
    ...result.rows[0],
    secret,  // ⚠️ Only shown once
    _warning: 'Store this secret securely. It is used to verify webhook signatures and will not be shown again.',
  }, 201);
});

// DELETE /api/webhooks/:id
webhooks.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const result = await query(
    'DELETE FROM webhook_endpoints WHERE id = $1 AND user_id = $2 RETURNING id',
    [c.req.param('id'), userId]
  );

  if (result.rows.length === 0) {
    return c.json({
      error: { type: 'invalid_request_error', code: 'resource_not_found', message: 'Webhook endpoint not found.' },
    }, 404);
  }

  audit({
    ...auditContext(c), action: 'delete_webhook', resource_type: 'webhook_endpoint',
    resource_id: c.req.param('id'), user_id: userId,
  });

  return c.json({ object: 'webhook_endpoint', id: c.req.param('id'), deleted: true });
});

export default webhooks;
