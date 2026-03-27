import { Context } from 'hono';
import { query } from '../db/pool.js';

/**
 * Audit log — records every mutation for compliance and debugging.
 *
 * Stripe logs every API call. We log mutations with:
 * - Who (user_id, api_key_id)
 * - What (action, resource_type, resource_id)
 * - When (timestamp)
 * - How (IP, user agent, request ID, idempotency key)
 * - What changed (before/after snapshots for sensitive ops)
 */

export type AuditAction =
  | 'create' | 'update' | 'delete' | 'restore'
  | 'login' | 'logout' | 'register'
  | 'sync_push' | 'sync_pull'
  | 'classify' | 'fill'
  | 'subscribe' | 'cancel_subscription'
  | 'create_api_key' | 'revoke_api_key'
  | 'create_webhook' | 'delete_webhook';

export interface AuditEntry {
  user_id: string;
  action: AuditAction;
  resource_type: string;
  resource_id?: string;
  ip_address?: string;
  user_agent?: string;
  request_id?: string;
  api_key_id?: string;
  metadata?: Record<string, any>;
}

/**
 * Log an audit entry. Non-blocking — failures are logged but don't affect the request.
 */
export async function audit(entry: AuditEntry): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_log (user_id, action, resource_type, resource_id, ip_address, user_agent, request_id, api_key_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        entry.user_id,
        entry.action,
        entry.resource_type,
        entry.resource_id || null,
        entry.ip_address || null,
        entry.user_agent || null,
        entry.request_id || null,
        entry.api_key_id || null,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
      ]
    );
  } catch (err: any) {
    console.error('[Audit] Failed to log:', err.message);
  }
}

/**
 * Extract audit context from a Hono request.
 */
export function auditContext(c: Context): Partial<AuditEntry> {
  return {
    user_id: c.get('userId'),
    ip_address: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || undefined,
    user_agent: c.req.header('user-agent') || undefined,
    request_id: c.get('requestId'),
    api_key_id: c.get('apiKey')?.keyId,
  };
}
