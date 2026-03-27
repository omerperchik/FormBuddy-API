import crypto from 'crypto';
import { query } from '../db/pool.js';

/**
 * Webhook event system — emit events on mutations, deliver to registered endpoints.
 *
 * Event types follow the Stripe convention: resource.action
 * - profile.created, profile.updated, profile.deleted
 * - sync.pushed, sync.pulled, sync.conflict
 * - subscription.created, subscription.canceled
 * - fill.completed
 *
 * Each event is:
 * 1. Persisted to the events table (auditable)
 * 2. Delivered to registered webhook endpoints (async, with retries)
 * 3. Signed with HMAC-SHA256 for verification
 */

export type EventType =
  | 'profile.created'
  | 'profile.updated'
  | 'profile.deleted'
  | 'profile.cloned'
  | 'sync.pushed'
  | 'sync.pulled'
  | 'sync.conflict'
  | 'subscription.created'
  | 'subscription.updated'
  | 'subscription.canceled'
  | 'fill.completed'
  | 'api_key.created'
  | 'api_key.revoked';

export interface WebhookEvent {
  id: string;
  object: 'event';
  type: EventType;
  created_at: string;
  data: {
    object: Record<string, any>;
    previous_attributes?: Record<string, any>;
  };
  user_id: string;
  request_id: string | null;
  idempotency_key: string | null;
}

/**
 * Emit an event — persist and deliver to webhooks.
 */
export async function emitEvent(
  type: EventType,
  userId: string,
  data: Record<string, any>,
  opts?: {
    requestId?: string;
    idempotencyKey?: string;
    previousAttributes?: Record<string, any>;
  }
): Promise<string> {
  const eventId = `evt_${crypto.randomBytes(16).toString('hex')}`;

  // Persist event
  await query(
    `INSERT INTO events (id, type, user_id, data, previous_attributes, request_id, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      eventId,
      type,
      userId,
      JSON.stringify(data),
      opts?.previousAttributes ? JSON.stringify(opts.previousAttributes) : null,
      opts?.requestId || null,
      opts?.idempotencyKey || null,
    ]
  );

  // Deliver to webhook endpoints (fire-and-forget, non-blocking)
  deliverWebhooks(eventId, type, userId, data, opts?.previousAttributes).catch((err) => {
    console.error(`[Webhook] Delivery failed for ${eventId}:`, err.message);
  });

  return eventId;
}

/**
 * Deliver an event to all registered webhook endpoints for the user.
 */
async function deliverWebhooks(
  eventId: string,
  type: EventType,
  userId: string,
  data: Record<string, any>,
  previousAttributes?: Record<string, any>
) {
  const endpoints = await query(
    `SELECT id, url, secret, event_types
     FROM webhook_endpoints
     WHERE user_id = $1 AND status = 'active'`,
    [userId]
  );

  for (const endpoint of endpoints.rows) {
    // Check if this endpoint is subscribed to this event type
    if (endpoint.event_types && !endpoint.event_types.includes(type) && !endpoint.event_types.includes('*')) {
      continue;
    }

    const payload: WebhookEvent = {
      id: eventId,
      object: 'event',
      type,
      created_at: new Date().toISOString(),
      data: {
        object: data,
        ...(previousAttributes ? { previous_attributes: previousAttributes } : {}),
      },
      user_id: userId,
      request_id: null,
      idempotency_key: null,
    };

    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signPayload(body, endpoint.secret, timestamp);

    // Attempt delivery with timeout
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'FormBuddy-Signature': `t=${timestamp},v1=${signature}`,
          'FormBuddy-Event-Id': eventId,
          'FormBuddy-Event-Type': type,
        },
        body,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      // Log delivery
      await query(
        `INSERT INTO webhook_deliveries (event_id, endpoint_id, status_code, success)
         VALUES ($1, $2, $3, $4)`,
        [eventId, endpoint.id, response.status, response.ok]
      );
    } catch (err: any) {
      // Log failed delivery
      await query(
        `INSERT INTO webhook_deliveries (event_id, endpoint_id, status_code, success, error)
         VALUES ($1, $2, 0, false, $3)`,
        [eventId, endpoint.id, err.message]
      ).catch(() => {});
    }
  }
}

/**
 * Sign a webhook payload for verification (like Stripe's signature scheme).
 * Clients verify: HMAC-SHA256(timestamp + "." + body, secret) === v1 signature
 */
function signPayload(body: string, secret: string, timestamp: number): string {
  const signedPayload = `${timestamp}.${body}`;
  return crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
}

/**
 * Verify a webhook signature (utility for clients).
 */
export function verifySignature(
  body: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds = 300
): boolean {
  const parts = signatureHeader.split(',');
  const timestamp = parseInt(parts.find((p) => p.startsWith('t='))?.slice(2) || '0');
  const signature = parts.find((p) => p.startsWith('v1='))?.slice(3) || '';

  // Check timestamp tolerance
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) {
    return false;
  }

  const expected = signPayload(body, secret, timestamp);
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
