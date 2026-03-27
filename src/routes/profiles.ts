import { Hono } from 'hono';
import { z } from 'zod';
import { query, transaction } from '../db/pool.js';
import { authMiddleware } from '../middleware/auth.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { SENSITIVE_FIELDS } from '../types.js';
import { parsePagination, cursorWhereClause, paginatedResponse } from '../utils/pagination.js';
import { generateETag, handleConditionalRequest } from '../utils/response.js';
import { emitEvent } from '../services/webhooks.js';
import { audit, auditContext } from '../services/audit.js';

const profiles = new Hono();
profiles.use('*', authMiddleware);

const createProfileSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['personal', 'work', 'family', 'custom']).default('personal'),
  icon: z.string().max(10).default('👤'),
  is_default: z.boolean().default(false),
  fields: z.record(z.string()).optional(),
  custom_fields: z.array(z.object({
    label: z.string().max(100),
    value: z.string().max(5000),
  })).optional(),
});

const updateProfileSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  type: z.enum(['personal', 'work', 'family', 'custom']).optional(),
  icon: z.string().max(10).optional(),
  is_default: z.boolean().optional(),
  fields: z.record(z.string()).optional(),
  custom_fields: z.array(z.object({
    id: z.string().optional(),
    label: z.string().max(100),
    value: z.string().max(5000),
  })).optional(),
});

/**
 * Load a profile with fields. Supports ?expand[]=fields to include field values.
 * By default, returns profile metadata only (like Stripe's expandable objects).
 */
async function loadProfile(profileId: string, userId: string, expand: string[] = []) {
  const profileResult = await query(
    'SELECT * FROM profiles WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
    [profileId, userId]
  );
  if (profileResult.rows.length === 0) return null;

  const profile = profileResult.rows[0];
  const result: Record<string, any> = {
    object: 'profile',
    id: profile.id,
    name: profile.name,
    type: profile.type,
    icon: profile.icon,
    is_default: profile.is_default,
    created_at: profile.created_at,
    updated_at: profile.updated_at,
  };

  // Expandable: fields
  if (expand.includes('fields') || expand.includes('*')) {
    const fieldsResult = await query(
      'SELECT field_key, value, is_sensitive, vector_clock, updated_at FROM profile_fields WHERE profile_id = $1',
      [profileId]
    );

    const fields: Record<string, string> = {};
    for (const f of fieldsResult.rows) {
      fields[f.field_key] = f.is_sensitive ? decrypt(f.value) : f.value;
    }
    result.fields = fields;
  }

  // Expandable: custom_fields
  if (expand.includes('custom_fields') || expand.includes('*')) {
    const customResult = await query(
      'SELECT id, label, value, sort_order FROM custom_fields WHERE profile_id = $1 ORDER BY sort_order',
      [profileId]
    );
    result.custom_fields = customResult.rows;
  }

  return result;
}

function parseExpand(c: any): string[] {
  const expand = c.req.queries('expand[]') || c.req.queries('expand') || [];
  return expand;
}

// GET /api/profiles — cursor-based pagination
profiles.get('/', async (c) => {
  const userId = c.get('userId');
  const expand = parseExpand(c);
  const { limit, decodedCursor } = parsePagination(c);

  const { clause, params, nextParamIdx } = cursorWhereClause(decodedCursor, 2);

  const result = await query(
    `SELECT id, created_at FROM profiles
     WHERE user_id = $1 AND deleted_at IS NULL${clause}
     ORDER BY created_at DESC, id DESC
     LIMIT $${nextParamIdx}`,
    [userId, ...params, limit + 1]
  );

  const loaded = await Promise.all(
    result.rows.slice(0, limit).map((r) => loadProfile(r.id, userId, expand))
  );
  const profiles_list = loaded.filter(Boolean) as any[];

  // Add created_at to each for cursor encoding
  const withCursor = profiles_list.map((p, i) => ({
    ...p,
    created_at: result.rows[i].created_at,
  }));

  const response = paginatedResponse(withCursor as any, limit);
  const etag = generateETag(response);
  if (handleConditionalRequest(c, etag)) return c.body(null, 304);

  return c.json(response);
});

// GET /api/profiles/:id
profiles.get('/:id', async (c) => {
  const userId = c.get('userId');
  const expand = parseExpand(c);
  const profile = await loadProfile(c.req.param('id'), userId, expand.length ? expand : ['*']);

  if (!profile) {
    return c.json({
      error: { type: 'invalid_request_error', code: 'resource_not_found', message: 'Profile not found.', param: 'id' },
    }, 404);
  }

  const etag = generateETag(profile);
  if (handleConditionalRequest(c, etag)) return c.body(null, 304);

  return c.json(profile);
});

// POST /api/profiles
profiles.post('/', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  const parsed = createProfileSchema.safeParse(body);
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

  const { name, type, icon, is_default, fields, custom_fields } = parsed.data;

  // Free tier: max 2 profiles
  const tier = c.get('userTier');
  if (tier === 'free') {
    const count = await query(
      'SELECT COUNT(*) FROM profiles WHERE user_id = $1 AND deleted_at IS NULL',
      [userId]
    );
    if (parseInt(count.rows[0].count) >= 2) {
      return c.json({
        error: {
          type: 'authorization_error',
          code: 'tier_required',
          message: 'Free plan is limited to 2 profiles. Upgrade to Pro for unlimited profiles.',
        },
      }, 403);
    }
  }

  const profile = await transaction(async (client) => {
    if (is_default) {
      await client.query(
        'UPDATE profiles SET is_default = false WHERE user_id = $1 AND deleted_at IS NULL',
        [userId]
      );
    }

    const result = await client.query(
      `INSERT INTO profiles (user_id, name, type, icon, is_default) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [userId, name, type, icon, is_default]
    );
    const profileId = result.rows[0].id;

    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        if (!value) continue;
        const sensitive = SENSITIVE_FIELDS.has(key);
        const storedValue = sensitive ? encrypt(value) : value;
        await client.query(
          `INSERT INTO profile_fields (profile_id, field_key, value, is_sensitive) VALUES ($1, $2, $3, $4)`,
          [profileId, key, storedValue, sensitive]
        );
      }
    }

    if (custom_fields) {
      for (let i = 0; i < custom_fields.length; i++) {
        await client.query(
          `INSERT INTO custom_fields (profile_id, label, value, sort_order) VALUES ($1, $2, $3, $4)`,
          [profileId, custom_fields[i].label, custom_fields[i].value, i]
        );
      }
    }

    return result.rows[0];
  });

  const loaded = await loadProfile(profile.id, userId, ['*']);

  // Emit event + audit
  emitEvent('profile.created', userId, loaded!, { requestId: c.get('requestId') });
  audit({ ...auditContext(c), action: 'create', resource_type: 'profile', resource_id: profile.id, user_id: userId });

  return c.json(loaded, 201);
});

// PATCH /api/profiles/:id
profiles.patch('/:id', async (c) => {
  const userId = c.get('userId');
  const profileId = c.req.param('id');
  const body = await c.req.json();
  const parsed = updateProfileSchema.safeParse(body);
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

  // Load previous state for event diff
  const previous = await loadProfile(profileId, userId, ['*']);
  if (!previous) {
    return c.json({
      error: { type: 'invalid_request_error', code: 'resource_not_found', message: 'Profile not found.', param: 'id' },
    }, 404);
  }

  const { name, type, icon, is_default, fields, custom_fields } = parsed.data;

  await transaction(async (client) => {
    const updates: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (name !== undefined) { updates.push(`name = $${idx++}`); values.push(name); }
    if (type !== undefined) { updates.push(`type = $${idx++}`); values.push(type); }
    if (icon !== undefined) { updates.push(`icon = $${idx++}`); values.push(icon); }

    if (is_default) {
      await client.query('UPDATE profiles SET is_default = false WHERE user_id = $1 AND deleted_at IS NULL', [userId]);
      updates.push(`is_default = $${idx++}`);
      values.push(true);
    }

    if (updates.length > 0) {
      values.push(profileId);
      await client.query(`UPDATE profiles SET ${updates.join(', ')} WHERE id = $${idx}`, values);
    }

    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        const sensitive = SENSITIVE_FIELDS.has(key);
        if (value === '' || value === null) {
          await client.query(
            'DELETE FROM profile_fields WHERE profile_id = $1 AND field_key = $2',
            [profileId, key]
          );
        } else {
          const storedValue = sensitive ? encrypt(value) : value;
          await client.query(
            `INSERT INTO profile_fields (profile_id, field_key, value, is_sensitive, vector_clock)
             VALUES ($1, $2, $3, $4, 1)
             ON CONFLICT (profile_id, field_key)
             DO UPDATE SET value = $3, is_sensitive = $4, vector_clock = profile_fields.vector_clock + 1`,
            [profileId, key, storedValue, sensitive]
          );
        }
      }
    }

    if (custom_fields) {
      await client.query('DELETE FROM custom_fields WHERE profile_id = $1', [profileId]);
      for (let i = 0; i < custom_fields.length; i++) {
        await client.query(
          `INSERT INTO custom_fields (profile_id, label, value, sort_order) VALUES ($1, $2, $3, $4)`,
          [profileId, custom_fields[i].label, custom_fields[i].value, i]
        );
      }
    }
  });

  const loaded = await loadProfile(profileId, userId, ['*']);

  // Emit event with previous attributes for diffing
  emitEvent('profile.updated', userId, loaded!, {
    requestId: c.get('requestId'),
    previousAttributes: previous,
  });
  audit({ ...auditContext(c), action: 'update', resource_type: 'profile', resource_id: profileId, user_id: userId });

  return c.json(loaded);
});

// DELETE /api/profiles/:id — soft delete with 30-day recovery
profiles.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const profileId = c.req.param('id');

  const result = await query(
    `UPDATE profiles SET deleted_at = NOW()
     WHERE id = $1 AND user_id = $2 AND is_default = false AND deleted_at IS NULL
     RETURNING id`,
    [profileId, userId]
  );

  if (result.rows.length === 0) {
    return c.json({
      error: {
        type: 'invalid_request_error',
        code: 'cannot_delete',
        message: 'Profile not found, already deleted, or is the default profile.',
        param: 'id',
      },
    }, 400);
  }

  emitEvent('profile.deleted', userId, { id: profileId }, { requestId: c.get('requestId') });
  audit({ ...auditContext(c), action: 'delete', resource_type: 'profile', resource_id: profileId, user_id: userId });

  return c.json({
    object: 'profile',
    id: profileId,
    deleted: true,
    recoverable_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  });
});

// POST /api/profiles/:id/restore — recover a soft-deleted profile
profiles.post('/:id/restore', async (c) => {
  const userId = c.get('userId');
  const profileId = c.req.param('id');

  const result = await query(
    `UPDATE profiles SET deleted_at = NULL
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NOT NULL AND deleted_at > NOW() - INTERVAL '30 days'
     RETURNING id`,
    [profileId, userId]
  );

  if (result.rows.length === 0) {
    return c.json({
      error: {
        type: 'invalid_request_error',
        code: 'resource_not_found',
        message: 'No recoverable profile found. Profiles can be recovered within 30 days of deletion.',
        param: 'id',
      },
    }, 404);
  }

  audit({ ...auditContext(c), action: 'restore', resource_type: 'profile', resource_id: profileId, user_id: userId });

  const loaded = await loadProfile(profileId, userId, ['*']);
  return c.json(loaded);
});

// POST /api/profiles/:id/clone
profiles.post('/:id/clone', async (c) => {
  const userId = c.get('userId');
  const sourceId = c.req.param('id');

  const source = await loadProfile(sourceId, userId, ['*']);
  if (!source) {
    return c.json({
      error: { type: 'invalid_request_error', code: 'resource_not_found', message: 'Profile not found.', param: 'id' },
    }, 404);
  }

  const cloned = await transaction(async (client) => {
    const result = await client.query(
      `INSERT INTO profiles (user_id, name, type, icon, is_default)
       VALUES ($1, $2, $3, $4, false) RETURNING *`,
      [userId, `${source.name} (Copy)`, source.type, source.icon]
    );
    const newId = result.rows[0].id;

    if (source.fields) {
      for (const [key, value] of Object.entries(source.fields as Record<string, string>)) {
        const sensitive = SENSITIVE_FIELDS.has(key);
        const storedValue = sensitive ? encrypt(value) : value;
        await client.query(
          `INSERT INTO profile_fields (profile_id, field_key, value, is_sensitive) VALUES ($1, $2, $3, $4)`,
          [newId, key, storedValue, sensitive]
        );
      }
    }

    if (source.custom_fields) {
      for (const cf of source.custom_fields as any[]) {
        await client.query(
          `INSERT INTO custom_fields (profile_id, label, value, sort_order) VALUES ($1, $2, $3, $4)`,
          [newId, cf.label, cf.value, cf.sort_order]
        );
      }
    }

    return result.rows[0];
  });

  const loaded = await loadProfile(cloned.id, userId, ['*']);

  emitEvent('profile.cloned', userId, { ...loaded!, cloned_from: sourceId }, { requestId: c.get('requestId') });
  audit({ ...auditContext(c), action: 'create', resource_type: 'profile', resource_id: cloned.id, user_id: userId,
    metadata: { cloned_from: sourceId } });

  return c.json(loaded, 201);
});

export default profiles;
