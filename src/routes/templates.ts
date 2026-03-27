import { Hono } from 'hono';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { authMiddleware } from '../middleware/auth.js';
import { parsePagination, cursorWhereClause, paginatedResponse } from '../utils/pagination.js';
import { generateETag, handleConditionalRequest } from '../utils/response.js';

const templates = new Hono();
templates.use('*', authMiddleware);

const createTemplateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  category: z.string().max(50).optional(),
  country: z.string().max(5).optional(),
  language: z.string().max(5).default('en'),
  field_mappings: z.array(z.object({
    fieldKey: z.string(),
    label: z.string(),
    autocomplete: z.string().optional(),
    required: z.boolean().optional(),
  })).min(1),
  is_public: z.boolean().default(false),
});

// GET /api/templates — cursor-based pagination with full-text search
templates.get('/', async (c) => {
  const userId = c.get('userId');
  const { limit, decodedCursor } = parsePagination(c);
  const category = c.req.query('category');
  const country = c.req.query('country');
  const search = c.req.query('q');

  let sql = `SELECT id, name, description, category, country, language, field_mappings, is_public, use_count, created_at
     FROM form_templates WHERE (is_public = true OR created_by = $1)`;
  const params: any[] = [userId];
  let idx = 2;

  if (category) { sql += ` AND category = $${idx++}`; params.push(category); }
  if (country) { sql += ` AND country = $${idx++}`; params.push(country); }
  if (search) {
    sql += ` AND to_tsvector('english', coalesce(name, '') || ' ' || coalesce(description, '')) @@ plainto_tsquery('english', $${idx})`;
    params.push(search);
    idx++;
  }

  const { clause, params: cursorParams, nextParamIdx } = cursorWhereClause(decodedCursor, idx);
  sql += clause;
  params.push(...cursorParams);

  sql += ` ORDER BY use_count DESC, created_at DESC, id DESC LIMIT $${nextParamIdx}`;
  params.push(limit + 1);

  const result = await query(sql, params);
  const templates_list = result.rows.map((t) => ({ object: 'form_template', ...t }));
  const response = paginatedResponse(templates_list, limit);

  const etag = generateETag(response);
  if (handleConditionalRequest(c, etag)) return c.body(null, 304);

  return c.json(response);
});

// GET /api/templates/:id
templates.get('/:id', async (c) => {
  const userId = c.get('userId');
  const result = await query(
    `SELECT * FROM form_templates WHERE id = $1 AND (is_public = true OR created_by = $2)`,
    [c.req.param('id'), userId]
  );

  if (result.rows.length === 0) {
    return c.json({
      error: { type: 'invalid_request_error', code: 'resource_not_found', message: 'Template not found.', param: 'id' },
    }, 404);
  }

  query('UPDATE form_templates SET use_count = use_count + 1 WHERE id = $1', [c.req.param('id')]).catch(() => {});

  const template = { object: 'form_template', ...result.rows[0] };
  const etag = generateETag(template);
  if (handleConditionalRequest(c, etag)) return c.body(null, 304);

  return c.json(template);
});

// POST /api/templates
templates.post('/', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  const parsed = createTemplateSchema.safeParse(body);
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

  const { name, description, category, country, language, field_mappings, is_public } = parsed.data;

  const result = await query(
    `INSERT INTO form_templates (name, description, category, country, language, field_mappings, is_public, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [name, description || null, category || null, country || null, language, JSON.stringify(field_mappings), is_public, userId]
  );

  return c.json({ object: 'form_template', ...result.rows[0] }, 201);
});

// DELETE /api/templates/:id
templates.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const result = await query(
    'DELETE FROM form_templates WHERE id = $1 AND created_by = $2 RETURNING id',
    [c.req.param('id'), userId]
  );

  if (result.rows.length === 0) {
    return c.json({
      error: { type: 'invalid_request_error', code: 'resource_not_found', message: 'Template not found or not owned by you.' },
    }, 404);
  }

  return c.json({ object: 'form_template', id: c.req.param('id'), deleted: true });
});

export default templates;
