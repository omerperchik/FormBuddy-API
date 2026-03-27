import { Hono } from 'hono';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { authMiddleware } from '../middleware/auth.js';

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
  })),
  is_public: z.boolean().default(false),
});

// GET /api/templates — list public templates (+ user's own)
templates.get('/', async (c) => {
  const userId = c.get('userId');
  const category = c.req.query('category');
  const country = c.req.query('country');
  const search = c.req.query('q');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const offset = parseInt(c.req.query('offset') || '0');

  let sql = `
    SELECT id, name, description, category, country, language, field_mappings, is_public, use_count, created_at
    FROM form_templates
    WHERE (is_public = true OR created_by = $1)`;
  const params: any[] = [userId];
  let idx = 2;

  if (category) {
    sql += ` AND category = $${idx++}`;
    params.push(category);
  }
  if (country) {
    sql += ` AND country = $${idx++}`;
    params.push(country);
  }
  if (search) {
    sql += ` AND (name ILIKE $${idx} OR description ILIKE $${idx})`;
    params.push(`%${search}%`);
    idx++;
  }

  sql += ` ORDER BY use_count DESC, created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
  params.push(limit, offset);

  const result = await query(sql, params);
  return c.json({ templates: result.rows });
});

// GET /api/templates/:id
templates.get('/:id', async (c) => {
  const userId = c.get('userId');
  const result = await query(
    `SELECT * FROM form_templates WHERE id = $1 AND (is_public = true OR created_by = $2)`,
    [c.req.param('id'), userId]
  );
  if (result.rows.length === 0) return c.json({ error: 'Template not found' }, 404);

  // Increment use count
  await query('UPDATE form_templates SET use_count = use_count + 1 WHERE id = $1', [c.req.param('id')]);

  return c.json({ template: result.rows[0] });
});

// POST /api/templates
templates.post('/', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  const parsed = createTemplateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const { name, description, category, country, language, field_mappings, is_public } = parsed.data;

  const result = await query(
    `INSERT INTO form_templates (name, description, category, country, language, field_mappings, is_public, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [name, description || null, category || null, country || null, language, JSON.stringify(field_mappings), is_public, userId]
  );

  return c.json({ template: result.rows[0] }, 201);
});

// DELETE /api/templates/:id
templates.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const result = await query(
    'DELETE FROM form_templates WHERE id = $1 AND created_by = $2 RETURNING id',
    [c.req.param('id'), userId]
  );
  if (result.rows.length === 0) return c.json({ error: 'Template not found or not owned' }, 404);
  return c.json({ ok: true });
});

export default templates;
