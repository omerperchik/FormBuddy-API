import { Hono } from 'hono';
import { z } from 'zod';
import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { query } from '../db/pool.js';
import { authMiddleware, requireTier } from '../middleware/auth.js';
import { FIELD_TYPES, type ClassifyResult, type FormFieldInput } from '../types.js';

const fields = new Hono();
fields.use('*', authMiddleware);

const classifySchema = z.object({
  fields: z.array(z.object({
    name: z.string(),
    label: z.string().optional(),
    type: z.string().optional(),
    placeholder: z.string().optional(),
    autocomplete: z.string().optional(),
  })),
  form_url: z.string().optional(),
});

const matchSchema = z.object({
  profile_id: z.string().uuid(),
  fields: z.array(z.object({
    name: z.string(),
    classified_type: z.string(),
  })),
});

function hashFormStructure(fields: FormFieldInput[]): string {
  const normalized = fields
    .map((f) => `${f.name}|${f.label || ''}|${f.type || ''}`)
    .sort()
    .join('\n');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

// POST /api/fields/classify — AI-powered field classification
fields.post('/classify', async (c) => {
  const body = await c.req.json();
  const parsed = classifySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const { fields: formFields, form_url } = parsed.data;
  const formHash = hashFormStructure(formFields);

  // Check cache first
  const cached = await query(
    'SELECT field_name, classified_type, confidence FROM field_classification_cache WHERE form_hash = $1',
    [formHash]
  );

  if (cached.rows.length === formFields.length) {
    const results: ClassifyResult[] = formFields.map((f) => {
      const hit = cached.rows.find((r) => r.field_name === f.name);
      return {
        name: f.name,
        classified_type: hit?.classified_type || null,
        confidence: hit?.confidence || 0,
      };
    });
    return c.json({ results, cached: true });
  }

  // Classify with Claude
  const anthropic = new Anthropic();
  const fieldDescriptions = formFields
    .map((f) => {
      const parts = [`name="${f.name}"`];
      if (f.label) parts.push(`label="${f.label}"`);
      if (f.type) parts.push(`type="${f.type}"`);
      if (f.placeholder) parts.push(`placeholder="${f.placeholder}"`);
      if (f.autocomplete) parts.push(`autocomplete="${f.autocomplete}"`);
      return parts.join(', ');
    })
    .join('\n');

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `Classify each HTML form field into one of these types: ${FIELD_TYPES.join(', ')}

Return a JSON array of objects with "name", "type" (one of the types above or null if unknown), and "confidence" (0-1).

Form fields:
${fieldDescriptions}

Return ONLY the JSON array, no other text.`,
    }],
  });

  let results: ClassifyResult[] = [];
  try {
    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const parsed = JSON.parse(text.replace(/```json?\n?|\n?```/g, ''));
    results = parsed.map((r: any) => ({
      name: r.name,
      classified_type: FIELD_TYPES.includes(r.type) ? r.type : null,
      confidence: Math.min(1, Math.max(0, r.confidence || 0)),
    }));
  } catch {
    return c.json({ error: 'Failed to parse classification response' }, 500);
  }

  // Cache results
  for (const r of results) {
    if (r.classified_type) {
      const field = formFields.find((f) => f.name === r.name);
      await query(
        `INSERT INTO field_classification_cache (form_hash, field_name, field_label, classified_type, confidence)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (form_hash, field_name) DO UPDATE SET classified_type = $4, confidence = $5`,
        [formHash, r.name, field?.label || null, r.classified_type, r.confidence]
      );
    }
  }

  return c.json({ results, cached: false });
});

// POST /api/fields/match — match profile fields to classified form fields
fields.post('/match', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  const parsed = matchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const { profile_id, fields: formFields } = parsed.data;

  // Verify ownership
  const profile = await query(
    'SELECT id FROM profiles WHERE id = $1 AND user_id = $2',
    [profile_id, userId]
  );
  if (profile.rows.length === 0) {
    return c.json({ error: 'Profile not found' }, 404);
  }

  // Get all profile fields
  const profileFields = await query(
    'SELECT field_key, value, is_sensitive FROM profile_fields WHERE profile_id = $1',
    [profile_id]
  );

  const fieldMap = new Map(profileFields.rows.map((f) => [f.field_key, f]));

  const matches = formFields.map((f) => {
    const profileField = fieldMap.get(f.classified_type);
    return {
      form_field: f.name,
      classified_type: f.classified_type,
      has_value: !!profileField,
      // Don't send sensitive values in match response — client fills from local cache
      value: profileField && !profileField.is_sensitive ? profileField.value : undefined,
      is_sensitive: profileField?.is_sensitive || false,
    };
  });

  return c.json({ matches });
});

export default fields;
