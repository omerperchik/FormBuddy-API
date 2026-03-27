import { Hono } from 'hono';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { authMiddleware } from '../middleware/auth.js';

const history = new Hono();
history.use('*', authMiddleware);

const logFillSchema = z.object({
  profile_id: z.string().uuid().optional(),
  template_id: z.string().uuid().optional(),
  form_url: z.string().max(2000).optional(),
  form_title: z.string().max(500).optional(),
  fields_filled: z.number().int().min(0).default(0),
  source_platform: z.enum(['chrome', 'android', 'ios', 'web']),
});

// GET /api/history — list fill history
history.get('/', async (c) => {
  const userId = c.get('userId');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const offset = parseInt(c.req.query('offset') || '0');
  const platform = c.req.query('platform');

  let sql = `
    SELECT h.*, p.name as profile_name, t.name as template_name
    FROM fill_history h
    LEFT JOIN profiles p ON p.id = h.profile_id
    LEFT JOIN form_templates t ON t.id = h.template_id
    WHERE h.user_id = $1`;
  const params: any[] = [userId];
  let idx = 2;

  if (platform) {
    sql += ` AND h.source_platform = $${idx++}`;
    params.push(platform);
  }

  sql += ` ORDER BY h.filled_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
  params.push(limit, offset);

  const result = await query(sql, params);
  return c.json({ history: result.rows });
});

// POST /api/history — log a form fill
history.post('/', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  const parsed = logFillSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const { profile_id, template_id, form_url, form_title, fields_filled, source_platform } = parsed.data;

  const result = await query(
    `INSERT INTO fill_history (user_id, profile_id, template_id, form_url, form_title, fields_filled, source_platform)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [userId, profile_id || null, template_id || null, form_url || null, form_title || null, fields_filled, source_platform]
  );

  // Increment template use count if applicable
  if (template_id) {
    await query('UPDATE form_templates SET use_count = use_count + 1 WHERE id = $1', [template_id]);
  }

  return c.json({ entry: result.rows[0] }, 201);
});

// GET /api/history/stats — fill statistics
history.get('/stats', async (c) => {
  const userId = c.get('userId');

  const result = await query(
    `SELECT
       COUNT(*) as total_fills,
       SUM(fields_filled) as total_fields_filled,
       COUNT(DISTINCT form_url) as unique_forms,
       source_platform,
       COUNT(*) as platform_fills
     FROM fill_history
     WHERE user_id = $1
     GROUP BY source_platform`,
    [userId]
  );

  const totalResult = await query(
    `SELECT COUNT(*) as total_fills, SUM(fields_filled) as total_fields_filled, COUNT(DISTINCT form_url) as unique_forms
     FROM fill_history WHERE user_id = $1`,
    [userId]
  );

  return c.json({
    totals: totalResult.rows[0],
    by_platform: result.rows,
  });
});

export default history;
