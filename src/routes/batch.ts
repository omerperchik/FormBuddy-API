import { Hono } from 'hono';
import { z } from 'zod';
import { query, transaction } from '../db/pool.js';
import { authMiddleware } from '../middleware/auth.js';
import { encrypt } from '../utils/crypto.js';
import { SENSITIVE_FIELDS } from '../types.js';
import { audit, auditContext } from '../services/audit.js';

const batch = new Hono();
batch.use('*', authMiddleware);

const batchUpdateSchema = z.object({
  operations: z.array(z.object({
    profile_id: z.string().uuid(),
    fields: z.record(z.string()),
  })).min(1).max(50),
});

/**
 * POST /api/batch/profiles/fields — batch update fields across multiple profiles.
 *
 * Useful for:
 * - Changing email/phone across all profiles at once
 * - Initial sync from a legacy system
 * - Bulk imports
 *
 * Atomic: all updates succeed or all fail.
 */
batch.post('/profiles/fields', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  const parsed = batchUpdateSchema.safeParse(body);
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

  const { operations } = parsed.data;

  // Verify all profiles belong to user
  const profileIds = [...new Set(operations.map((op) => op.profile_id))];
  const profileCheck = await query(
    `SELECT id FROM profiles WHERE user_id = $1 AND deleted_at IS NULL AND id = ANY($2)`,
    [userId, profileIds]
  );

  const validIds = new Set(profileCheck.rows.map((r) => r.id));
  const invalidIds = profileIds.filter((id) => !validIds.has(id));

  if (invalidIds.length > 0) {
    return c.json({
      error: {
        type: 'invalid_request_error',
        code: 'resource_not_found',
        message: `Profiles not found: ${invalidIds.join(', ')}`,
        param: 'operations[].profile_id',
      },
    }, 404);
  }

  let totalUpdated = 0;

  await transaction(async (client) => {
    for (const op of operations) {
      for (const [key, value] of Object.entries(op.fields)) {
        const sensitive = SENSITIVE_FIELDS.has(key);

        if (value === '' || value === null) {
          await client.query(
            'DELETE FROM profile_fields WHERE profile_id = $1 AND field_key = $2',
            [op.profile_id, key]
          );
        } else {
          const storedValue = sensitive ? encrypt(value) : value;
          await client.query(
            `INSERT INTO profile_fields (profile_id, field_key, value, is_sensitive, vector_clock)
             VALUES ($1, $2, $3, $4, 1)
             ON CONFLICT (profile_id, field_key)
             DO UPDATE SET value = $3, is_sensitive = $4, vector_clock = profile_fields.vector_clock + 1`,
            [op.profile_id, key, storedValue, sensitive]
          );
        }
        totalUpdated++;
      }
    }
  });

  audit({
    ...auditContext(c), action: 'update', resource_type: 'batch_profile_fields', user_id: userId,
    metadata: { profiles_affected: profileIds.length, fields_updated: totalUpdated },
  });

  return c.json({
    object: 'batch_result',
    profiles_affected: profileIds.length,
    fields_updated: totalUpdated,
    status: 'completed',
  });
});

export default batch;
