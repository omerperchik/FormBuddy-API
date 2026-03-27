import { Hono } from 'hono';
import { query } from '../db/pool.js';
import { authMiddleware } from '../middleware/auth.js';
import { parsePagination, paginatedResponse } from '../utils/pagination.js';

const events = new Hono();
events.use('*', authMiddleware);

// GET /api/events — list events (like Stripe's event log)
events.get('/', async (c) => {
  const userId = c.get('userId');
  const { limit, decodedCursor } = parsePagination(c);
  const type = c.req.query('type');

  let sql = `SELECT id, type, data, previous_attributes, request_id, idempotency_key, created_at
     FROM events WHERE user_id = $1`;
  const params: any[] = [userId];
  let idx = 2;

  if (type) {
    sql += ` AND type = $${idx++}`;
    params.push(type);
  }

  if (decodedCursor) {
    sql += ` AND (created_at, id) < ($${idx}, $${idx + 1})`;
    params.push(decodedCursor.created_at, decodedCursor.id);
    idx += 2;
  }

  sql += ` ORDER BY created_at DESC, id DESC LIMIT $${idx}`;
  params.push(limit + 1);

  const result = await query(sql, params);
  const eventsList = result.rows.map((e) => ({
    object: 'event',
    ...e,
    data: typeof e.data === 'string' ? JSON.parse(e.data) : e.data,
    previous_attributes: e.previous_attributes
      ? (typeof e.previous_attributes === 'string' ? JSON.parse(e.previous_attributes) : e.previous_attributes)
      : undefined,
  }));

  return c.json(paginatedResponse(eventsList, limit));
});

// GET /api/events/:id
events.get('/:id', async (c) => {
  const userId = c.get('userId');
  const result = await query(
    'SELECT * FROM events WHERE id = $1 AND user_id = $2',
    [c.req.param('id'), userId]
  );

  if (result.rows.length === 0) {
    return c.json({
      error: { type: 'invalid_request_error', code: 'resource_not_found', message: 'Event not found.' },
    }, 404);
  }

  const e = result.rows[0];
  return c.json({
    object: 'event',
    ...e,
    data: typeof e.data === 'string' ? JSON.parse(e.data) : e.data,
  });
});

export default events;
