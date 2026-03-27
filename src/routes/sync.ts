import { Hono } from 'hono';
import { z } from 'zod';
import { query, transaction } from '../db/pool.js';
import { authMiddleware } from '../middleware/auth.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { SENSITIVE_FIELDS } from '../types.js';

const sync = new Hono();
sync.use('*', authMiddleware);

const pushSchema = z.object({
  device_id: z.string(),
  platform: z.enum(['chrome', 'android', 'ios']),
  changes: z.array(z.object({
    profile_id: z.string().uuid(),
    field_key: z.string(),
    value: z.string(),
    is_sensitive: z.boolean().default(false),
    vector_clock: z.number().int().min(1),
    updated_at: z.string(),
    action: z.enum(['upsert', 'delete']),
  })),
});

const pullSchema = z.object({
  device_id: z.string(),
  platform: z.enum(['chrome', 'android', 'ios']),
  last_synced: z.string().nullable(),
});

// POST /api/sync/push — push local changes to server
sync.post('/push', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  const parsed = pushSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const { device_id, platform, changes } = parsed.data;
  const conflicts: any[] = [];
  const applied: string[] = [];

  await transaction(async (client) => {
    for (const change of changes) {
      // Verify profile ownership
      const profile = await client.query(
        'SELECT id FROM profiles WHERE id = $1 AND user_id = $2',
        [change.profile_id, userId]
      );
      if (profile.rows.length === 0) continue;

      if (change.action === 'delete') {
        await client.query(
          'DELETE FROM profile_fields WHERE profile_id = $1 AND field_key = $2',
          [change.profile_id, change.field_key]
        );
        applied.push(`${change.profile_id}:${change.field_key}`);
        continue;
      }

      // Check for conflicts via vector clock
      const existing = await client.query(
        'SELECT vector_clock, updated_at FROM profile_fields WHERE profile_id = $1 AND field_key = $2',
        [change.profile_id, change.field_key]
      );

      if (existing.rows.length > 0) {
        const serverClock = existing.rows[0].vector_clock;
        if (change.vector_clock <= serverClock) {
          // Conflict — server has newer or equal version
          conflicts.push({
            profile_id: change.profile_id,
            field_key: change.field_key,
            client_clock: change.vector_clock,
            server_clock: serverClock,
            server_updated_at: existing.rows[0].updated_at,
          });
          continue;
        }
      }

      // Apply change
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

    // Update sync ledger
    await client.query(
      `INSERT INTO sync_ledger (user_id, device_id, platform, last_synced)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, device_id)
       DO UPDATE SET last_synced = NOW(), platform = $3`,
      [userId, device_id, platform]
    );
  });

  return c.json({
    applied: applied.length,
    conflicts,
  });
});

// POST /api/sync/pull — pull changes since last sync
sync.post('/pull', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  const parsed = pullSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const { device_id, platform, last_synced } = parsed.data;

  // Get all profiles for user
  const profilesResult = await query(
    'SELECT id, name, type, icon, is_default, created_at, updated_at FROM profiles WHERE user_id = $1',
    [userId]
  );

  // Get changed fields since last sync
  let fieldsQuery: string;
  let fieldsParams: any[];

  if (last_synced) {
    fieldsQuery = `
      SELECT pf.profile_id, pf.field_key, pf.value, pf.is_sensitive, pf.vector_clock, pf.updated_at
      FROM profile_fields pf
      JOIN profiles p ON p.id = pf.profile_id
      WHERE p.user_id = $1 AND pf.updated_at > $2
      ORDER BY pf.updated_at`;
    fieldsParams = [userId, last_synced];
  } else {
    fieldsQuery = `
      SELECT pf.profile_id, pf.field_key, pf.value, pf.is_sensitive, pf.vector_clock, pf.updated_at
      FROM profile_fields pf
      JOIN profiles p ON p.id = pf.profile_id
      WHERE p.user_id = $1
      ORDER BY pf.updated_at`;
    fieldsParams = [userId];
  }

  const fieldsResult = await query(fieldsQuery, fieldsParams);

  const changes = fieldsResult.rows.map((f) => ({
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
     ON CONFLICT (user_id, device_id)
     DO UPDATE SET last_synced = NOW()`,
    [userId, device_id, platform]
  );

  return c.json({
    profiles: profilesResult.rows,
    changes,
    synced_at: new Date().toISOString(),
  });
});

// GET /api/sync/status — get sync status for all devices
sync.get('/status', async (c) => {
  const userId = c.get('userId');
  const result = await query(
    'SELECT device_id, platform, last_synced FROM sync_ledger WHERE user_id = $1 ORDER BY last_synced DESC',
    [userId]
  );
  return c.json({ devices: result.rows });
});

export default sync;
