import { Hono } from 'hono';
import { z } from 'zod';
import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { query } from '../db/pool.js';
import { authMiddleware } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { audit, auditContext } from '../services/audit.js';
import { FIELD_TYPES, type ClassifyResult, type FormFieldInput } from '../types.js';

const fields = new Hono();
fields.use('*', authMiddleware);

// AI classification is expensive — strict rate limit
fields.use('/classify', rateLimit(20, 60_000));

const classifySchema = z.object({
  fields: z.array(z.object({
    name: z.string(),
    label: z.string().optional(),
    type: z.string().optional(),
    placeholder: z.string().optional(),
    autocomplete: z.string().optional(),
  })).min(1).max(200),
  form_url: z.string().max(2000).optional(),
});

const matchSchema = z.object({
  profile_id: z.string().uuid(),
  fields: z.array(z.object({
    name: z.string(),
    classified_type: z.string(),
  })).min(1).max(200),
});

function hashFormStructure(fields: FormFieldInput[]): string {
  const normalized = fields
    .map((f) => `${f.name}|${f.label || ''}|${f.type || ''}`)
    .sort()
    .join('\n');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// POST /api/fields/classify
fields.post('/classify', async (c) => {
  const body = await c.req.json();
  const parsed = classifySchema.safeParse(body);
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

  const { fields: formFields, form_url } = parsed.data;
  const formHash = hashFormStructure(formFields);

  // Check cache
  const cached = await query(
    'SELECT field_name, classified_type, confidence FROM field_classification_cache WHERE form_hash = $1',
    [formHash]
  );

  if (cached.rows.length >= formFields.length) {
    // Update hit counts
    query(
      'UPDATE field_classification_cache SET hit_count = hit_count + 1 WHERE form_hash = $1',
      [formHash]
    ).catch(() => {});

    const results: ClassifyResult[] = formFields.map((f) => {
      const hit = cached.rows.find((r) => r.field_name === f.name);
      return {
        name: f.name,
        classified_type: hit?.classified_type || null,
        confidence: hit?.confidence || 0,
      };
    });

    return c.json({
      object: 'classification_result',
      results,
      cached: true,
      form_hash: formHash,
    });
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
    max_tokens: 2048,
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
    const cleaned = text.replace(/```json?\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    results = parsed.map((r: any) => ({
      name: String(r.name),
      classified_type: FIELD_TYPES.includes(r.type) ? r.type : null,
      confidence: Math.min(1, Math.max(0, Number(r.confidence) || 0)),
    }));
  } catch {
    return c.json({
      error: {
        type: 'api_error',
        code: 'classification_failed',
        message: 'Failed to classify form fields. The AI response was malformed. Please retry.',
      },
    }, 502);
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
      ).catch(() => {});
    }
  }

  audit({
    ...auditContext(c),
    action: 'classify',
    resource_type: 'field_classification',
    user_id: c.get('userId'),
    metadata: { form_hash: formHash, field_count: formFields.length },
  });

  return c.json({
    object: 'classification_result',
    results,
    cached: false,
    form_hash: formHash,
    model: 'claude-haiku-4-5-20251001',
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
  });
});

// POST /api/fields/match
fields.post('/match', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  const parsed = matchSchema.safeParse(body);
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

  const { profile_id, fields: formFields } = parsed.data;

  const profile = await query(
    'SELECT id FROM profiles WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
    [profile_id, userId]
  );
  if (profile.rows.length === 0) {
    return c.json({
      error: { type: 'invalid_request_error', code: 'resource_not_found', message: 'Profile not found.', param: 'profile_id' },
    }, 404);
  }

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
      value: profileField && !profileField.is_sensitive ? profileField.value : undefined,
      is_sensitive: profileField?.is_sensitive || false,
    };
  });

  const matched = matches.filter((m) => m.has_value).length;

  return c.json({
    object: 'match_result',
    profile_id,
    matches,
    summary: {
      total_fields: formFields.length,
      matched: matched,
      unmatched: formFields.length - matched,
      coverage: formFields.length > 0 ? Math.round((matched / formFields.length) * 100) : 0,
    },
  });
});

export default fields;
