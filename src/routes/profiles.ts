import { Hono } from 'hono';
import { z } from 'zod';
import { query, transaction } from '../db/pool.js';
import { authMiddleware } from '../middleware/auth.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { SENSITIVE_FIELDS } from '../types.js';

const profiles = new Hono();
profiles.use('*', authMiddleware);

const createProfileSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['personal', 'work', 'family', 'custom']).default('personal'),
  icon: z.string().max(10).default('👤'),
  is_default: z.boolean().default(false),
  fields: z.record(z.string()).optional(),
  custom_fields: z.array(z.object({
    label: z.string(),
    value: z.string(),
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
    label: z.string(),
    value: z.string(),
  })).optional(),
});

// Helper: load profile with fields
async function loadProfile(profileId: string, userId: string) {
  const profileResult = await query(
    'SELECT * FROM profiles WHERE id = $1 AND user_id = $2',
    [profileId, userId]
  );
  if (profileResult.rows.length === 0) return null;

  const profile = profileResult.rows[0];

  const fieldsResult = await query(
    'SELECT field_key, value, is_sensitive, vector_clock, updated_at FROM profile_fields WHERE profile_id = $1',
    [profileId]
  );

  const fields: Record<string, string> = {};
  for (const f of fieldsResult.rows) {
    fields[f.field_key] = f.is_sensitive ? decrypt(f.value) : f.value;
  }

  const customResult = await query(
    'SELECT id, label, value, sort_order FROM custom_fields WHERE profile_id = $1 ORDER BY sort_order',
    [profileId]
  );

  return {
    id: profile.id,
    user_id: profile.user_id,
    name: profile.name,
    type: profile.type,
    icon: profile.icon,
    is_default: profile.is_default,
    fields,
    custom_fields: customResult.rows,
    created_at: profile.created_at,
    updated_at: profile.updated_at,
  };
}

// GET /api/profiles
profiles.get('/', async (c) => {
  const userId = c.get('userId');
  const result = await query(
    'SELECT id FROM profiles WHERE user_id = $1 ORDER BY is_default DESC, created_at',
    [userId]
  );

  const loaded = await Promise.all(
    result.rows.map((r) => loadProfile(r.id, userId))
  );

  return c.json({ profiles: loaded.filter(Boolean) });
});

// GET /api/profiles/:id
profiles.get('/:id', async (c) => {
  const userId = c.get('userId');
  const profile = await loadProfile(c.req.param('id'), userId);
  if (!profile) return c.json({ error: 'Profile not found' }, 404);
  return c.json({ profile });
});

// POST /api/profiles
profiles.post('/', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  const parsed = createProfileSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const { name, type, icon, is_default, fields, custom_fields } = parsed.data;

  // Free tier: max 2 profiles
  const tier = c.get('userTier');
  if (tier === 'free') {
    const count = await query('SELECT COUNT(*) FROM profiles WHERE user_id = $1', [userId]);
    if (parseInt(count.rows[0].count) >= 2) {
      return c.json({ error: 'Free tier limited to 2 profiles. Upgrade to Pro.' }, 403);
    }
  }

  const profile = await transaction(async (client) => {
    // If setting as default, unset others
    if (is_default) {
      await client.query('UPDATE profiles SET is_default = false WHERE user_id = $1', [userId]);
    }

    const result = await client.query(
      `INSERT INTO profiles (user_id, name, type, icon, is_default)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [userId, name, type, icon, is_default]
    );
    const profileId = result.rows[0].id;

    // Insert fields
    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        if (!value) continue;
        const sensitive = SENSITIVE_FIELDS.has(key);
        const storedValue = sensitive ? encrypt(value) : value;
        await client.query(
          `INSERT INTO profile_fields (profile_id, field_key, value, is_sensitive)
           VALUES ($1, $2, $3, $4)`,
          [profileId, key, storedValue, sensitive]
        );
      }
    }

    // Insert custom fields
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

  const loaded = await loadProfile(profile.id, userId);
  return c.json({ profile: loaded }, 201);
});

// PATCH /api/profiles/:id
profiles.patch('/:id', async (c) => {
  const userId = c.get('userId');
  const profileId = c.req.param('id');
  const body = await c.req.json();
  const parsed = updateProfileSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  // Verify ownership
  const existing = await query(
    'SELECT id FROM profiles WHERE id = $1 AND user_id = $2',
    [profileId, userId]
  );
  if (existing.rows.length === 0) {
    return c.json({ error: 'Profile not found' }, 404);
  }

  const { name, type, icon, is_default, fields, custom_fields } = parsed.data;

  await transaction(async (client) => {
    // Update profile metadata
    const updates: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (name !== undefined) { updates.push(`name = $${idx++}`); values.push(name); }
    if (type !== undefined) { updates.push(`type = $${idx++}`); values.push(type); }
    if (icon !== undefined) { updates.push(`icon = $${idx++}`); values.push(icon); }

    if (is_default) {
      await client.query('UPDATE profiles SET is_default = false WHERE user_id = $1', [userId]);
      updates.push(`is_default = $${idx++}`);
      values.push(true);
    }

    if (updates.length > 0) {
      values.push(profileId);
      await client.query(
        `UPDATE profiles SET ${updates.join(', ')} WHERE id = $${idx}`,
        values
      );
    }

    // Upsert fields
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

    // Replace custom fields
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

  const loaded = await loadProfile(profileId, userId);
  return c.json({ profile: loaded });
});

// DELETE /api/profiles/:id
profiles.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const profileId = c.req.param('id');

  const result = await query(
    'DELETE FROM profiles WHERE id = $1 AND user_id = $2 AND is_default = false RETURNING id',
    [profileId, userId]
  );

  if (result.rows.length === 0) {
    return c.json({ error: 'Profile not found or cannot delete default profile' }, 400);
  }

  return c.json({ ok: true });
});

// POST /api/profiles/:id/clone
profiles.post('/:id/clone', async (c) => {
  const userId = c.get('userId');
  const sourceId = c.req.param('id');

  const source = await loadProfile(sourceId, userId);
  if (!source) return c.json({ error: 'Profile not found' }, 404);

  const cloned = await transaction(async (client) => {
    const result = await client.query(
      `INSERT INTO profiles (user_id, name, type, icon, is_default)
       VALUES ($1, $2, $3, $4, false) RETURNING *`,
      [userId, `${source.name} (Copy)`, source.type, source.icon]
    );
    const newId = result.rows[0].id;

    // Copy fields
    for (const [key, value] of Object.entries(source.fields)) {
      const sensitive = SENSITIVE_FIELDS.has(key);
      const storedValue = sensitive ? encrypt(value) : value;
      await client.query(
        `INSERT INTO profile_fields (profile_id, field_key, value, is_sensitive) VALUES ($1, $2, $3, $4)`,
        [newId, key, storedValue, sensitive]
      );
    }

    // Copy custom fields
    for (const cf of source.custom_fields) {
      await client.query(
        `INSERT INTO custom_fields (profile_id, label, value, sort_order) VALUES ($1, $2, $3, $4)`,
        [newId, cf.label, cf.value, cf.sort_order]
      );
    }

    return result.rows[0];
  });

  const loaded = await loadProfile(cloned.id, userId);
  return c.json({ profile: loaded }, 201);
});

export default profiles;
