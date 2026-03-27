import { Hono } from 'hono';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { authMiddleware } from '../middleware/auth.js';
import { parsePagination, cursorWhereClause, paginatedResponse } from '../utils/pagination.js';
import { emitEvent } from '../services/webhooks.js';
import { audit, auditContext } from '../services/audit.js';

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

// GET /api/history — cursor-based pagination
history.get('/', async (c) => {
  const userId = c.get('userId');
  const { limit, decodedCursor } = parsePagination(c);
  const platform = c.req.query('platform');

  let sql = `
    SELECT h.id, h.profile_id, h.template_id, h.form_url, h.form_title,
           h.fields_filled, h.source_platform, h.filled_at, h.created_at,
           p.name as profile_name, t.name as template_name
    FROM fill_history h
    LEFT JOIN profiles p ON p.id = h.profile_id
    LEFT JOIN form_templates t ON t.id = h.template_id
    WHERE h.user_id = $1`;
  const params: any[] = [userId];
  let idx = 2;

  if (platform) { sql += ` AND h.source_platform = $${idx++}`; params.push(platform); }

  const { clause, params: cursorParams, nextParamIdx } = cursorWhereClause(decodedCursor, idx);
  sql += clause.replace('created_at', 'h.created_at').replace('id', 'h.id');
  params.push(...cursorParams);

  sql += ` ORDER BY h.filled_at DESC, h.id DESC LIMIT $${nextParamIdx}`;
  params.push(limit + 1);

  const result = await query(sql, params);
  const entries = result.rows.map((r) => ({ object: 'fill_history_entry', ...r }));

  return c.json(paginatedResponse(entries, limit));
});

// POST /api/history
history.post('/', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  const parsed = logFillSchema.safeParse(body);
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

  const { profile_id, template_id, form_url, form_title, fields_filled, source_platform } = parsed.data;

  const result = await query(
    `INSERT INTO fill_history (user_id, profile_id, template_id, form_url, form_title, fields_filled, source_platform)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [userId, profile_id || null, template_id || null, form_url || null, form_title || null, fields_filled, source_platform]
  );

  if (template_id) {
    query('UPDATE form_templates SET use_count = use_count + 1 WHERE id = $1', [template_id]).catch(() => {});
  }

  emitEvent('fill.completed', userId, { ...result.rows[0], fields_filled, source_platform }, {
    requestId: c.get('requestId'),
  });

  audit({
    ...auditContext(c), action: 'fill', resource_type: 'fill_history',
    resource_id: result.rows[0].id, user_id: userId,
    metadata: { fields_filled, source_platform },
  });

  return c.json({ object: 'fill_history_entry', ...result.rows[0] }, 201);
});

// GET /api/history/stats
history.get('/stats', async (c) => {
  const userId = c.get('userId');

  const [totals, byPlatform, recent] = await Promise.all([
    query(
      `SELECT COUNT(*)::int as total_fills, COALESCE(SUM(fields_filled), 0)::int as total_fields_filled,
              COUNT(DISTINCT form_url) as unique_forms
       FROM fill_history WHERE user_id = $1`,
      [userId]
    ),
    query(
      `SELECT source_platform, COUNT(*)::int as fills, COALESCE(SUM(fields_filled), 0)::int as fields_filled
       FROM fill_history WHERE user_id = $1 GROUP BY source_platform`,
      [userId]
    ),
    query(
      `SELECT DATE(filled_at) as date, COUNT(*)::int as fills
       FROM fill_history WHERE user_id = $1 AND filled_at > NOW() - INTERVAL '30 days'
       GROUP BY DATE(filled_at) ORDER BY date DESC`,
      [userId]
    ),
  ]);

  return c.json({
    object: 'fill_stats',
    totals: totals.rows[0],
    by_platform: byPlatform.rows,
    last_30_days: recent.rows,
  });
});

export default history;
