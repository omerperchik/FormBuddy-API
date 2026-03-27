import { Hono } from 'hono';
import { z } from 'zod';
import { query, transaction } from '../db/pool.js';
import { authMiddleware } from '../middleware/auth.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { SENSITIVE_FIELDS } from '../types.js';
import { emitEvent } from '../services/webhooks.js';
import { audit, auditContext } from '../services/audit.js';

const sync = new Hono();
sync.use('*', authMiddleware);

const pushSchema = z.object({
  device_id: z.string().max(255),
  platform: z.enum(['chrome', 'android', 'ios']),
  changes: z.array(z.object({
    profile_id: z.string().uuid(),
    field_key: z.string().max(100),
    value: z.string().max(50000),
    is_sensitive: z.boolean().default(false),
    vector_clock: z.number().int().min(1),
    updated_at: z.string(),
    action: z.enum(['upsert', 'delete']),
  })).min(1).max(500),
});

const pullSchema = z.object({
  device_id: z.string().max(255),
  platform: z.enum(['chrome', 'android', 'ios']),
  last_synced: z.string().nullable(),
  limit: z.number().int().min(1).max(1000).default(500),
});

// POST /api/sync/push
sync.post('/push', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  const parsed = pushSchema.safeParse(body);
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

  const { device_id, platform, changes } = parsed.data;
  const conflicts: any[] = [];
  const applied: string[] = [];
  const rejected: string[] = [];

  await transaction(async (client) => {
    for (const change of changes) {
      const profile = await client.query(
        'SELECT id FROM profiles WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
        [change.profile_id, userId]
      );
      if (profile.rows.length === 0) {
        rejected.push(`${change.profile_id}:${change.field_key}`);
        continue;
      }

      if (change.action === 'delete') {
        await client.query(
          'DELETE FROM profile_fields WHERE profile_id = $1 AND field_key = $2',
          [change.profile_id, change.field_key]
        );
        applied.push(`${change.profile_id}:${change.field_key}`);
        continue;
      }

      // Conflict detection via vector clock
      const existing = await client.query(
        'SELECT vector_clock, updated_at FROM profile_fields WHERE profile_id = $1 AND field_key = $2',
        [change.profile_id, change.field_key]
      );

      if (existing.rows.length > 0 && change.vector_clock <= existing.rows[0].vector_clock) {
        conflicts.push({
          profile_id: change.profile_id,
          field_key: change.field_key,
          client_clock: change.vector_clock,
          server_clock: existing.rows[0].vector_clock,
          server_updated_at: existing.rows[0].updated_at,
          resolution: 'server_wins',
        });
        continue;
      }

      const sensitive = SENSITIVE_FIELDS.has(change.field_key) || change.is_sensitive;
      const storedValue = sensitive ? encrypt(change.value) : change.value;

      await client.query(
        `INSERT INTO profile_fields (profile_id, field_key, value, is_sensitive, vector_clock, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (profile_id, field_key)
         DO UPDATE SET value = $3, is_sensitive = $4, vector_clock = $5, updated_at = $6`,
        [change.profile_id, change.field_key, storedValue, sensitive, change.vector_clock, change.updated_at]
      );
      applied.push(`${change.profile_id}:${change.field_key}`);
    }

    await client.query(
      `INSERT INTO sync_ledger (user_id, device_id, platform, last_synced)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, device_id)
       DO UPDATE SET last_synced = NOW(), platform = $3`,
      [userId, device_id, platform]
    );
  });

  if (conflicts.length > 0) {
    emitEvent('sync.conflict', userId, { conflicts, device_id }, { requestId: c.get('requestId') });
  }
  if (applied.length > 0) {
    emitEvent('sync.pushed', userId, {
      device_id, platform, applied_count: applied.length,
    }, { requestId: c.get('requestId') });
  }

  audit({
    ...auditContext(c), action: 'sync_push', resource_type: 'sync', user_id: userId,
    metadata: { device_id, applied: applied.length, conflicts: conflicts.length, rejected: rejected.length },
  });

  return c.json({
    object: 'sync_result',
    applied: applied.length,
    conflicts,
    rejected: rejected.length,
    synced_at: new Date().toISOString(),
  });
});

// POST /api/sync/pull — paginated pull
sync.post('/pull', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  const parsed = pullSchema.safeParse(body);
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

  const { device_id, platform, last_synced, limit } = parsed.data;

  // Get profiles
  const profilesResult = await query(
    'SELECT id, name, type, icon, is_default, created_at, updated_at FROM profiles WHERE user_id = $1 AND deleted_at IS NULL',
    [userId]
  );

  // Get changes since last sync (paginated)
  let fieldsQuery: string;
  let fieldsParams: any[];

  if (last_synced) {
    fieldsQuery = `
      SELECT pf.profile_id, pf.field_key, pf.value, pf.is_sensitive, pf.vector_clock, pf.updated_at
      FROM profile_fields pf
      JOIN profiles p ON p.id = pf.profile_id
      WHERE p.user_id = $1 AND pf.updated_at > $2 AND p.deleted_at IS NULL
      ORDER BY pf.updated_at ASC
      LIMIT $3`;
    fieldsParams = [userId, last_synced, limit + 1];
  } else {
    fieldsQuery = `
      SELECT pf.profile_id, pf.field_key, pf.value, pf.is_sensitive, pf.vector_clock, pf.updated_at
      FROM profile_fields pf
      JOIN profiles p ON p.id = pf.profile_id
      WHERE p.user_id = $1 AND p.deleted_at IS NULL
      ORDER BY pf.updated_at ASC
      LIMIT $2`;
    fieldsParams = [userId, limit + 1];
  }

  const fieldsResult = await query(fieldsQuery, fieldsParams);
  const hasMore = fieldsResult.rows.length > limit;
  const rows = hasMore ? fieldsResult.rows.slice(0, limit) : fieldsResult.rows;

  const changes = rows.map((f) => ({
    profile_id: f.profile_id,
    field_key: f.field_key,
    value: f.is_sensitive ? decrypt(f.value) : f.value,
    is_sensitive: f.is_sensitive,
    vector_clock: f.vector_clock,
    updated_at: f.updated_at,
  }));

  // Update sync ledger
  await query(
    `INSERT INTO sync_ledger (user_id, device_id, platform, last_synced)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, device_id) DO UPDATE SET last_synced = NOW()`,
    [userId, device_id, platform]
  );

  const syncedAt = new Date().toISOString();

  emitEvent('sync.pulled', userId, { device_id, platform, changes_count: changes.length }, {
    requestId: c.get('requestId'),
  });

  audit({
    ...auditContext(c), action: 'sync_pull', resource_type: 'sync', user_id: userId,
    metadata: { device_id, changes_pulled: changes.length },
  });

  return c.json({
    object: 'sync_pull_result',
    profiles: profilesResult.rows,
    changes,
    has_more: hasMore,
    synced_at: syncedAt,
  });
});

// GET /api/sync/status
sync.get('/status', async (c) => {
  const userId = c.get('userId');
  const result = await query(
    'SELECT device_id, platform, last_synced FROM sync_ledger WHERE user_id = $1 ORDER BY last_synced DESC',
    [userId]
  );
  return c.json({
    object: 'list',
    data: result.rows,
  });
});

export default sync;
