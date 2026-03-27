import { Context } from 'hono';

/**
 * Cursor-based pagination — the Stripe way.
 *
 * Instead of offset/limit (which breaks with concurrent inserts),
 * we use opaque cursors that encode the position in the result set.
 *
 * Response format:
 * {
 *   data: [...],
 *   has_more: true,
 *   next_cursor: "crs_...",
 * }
 *
 * Client sends: ?cursor=crs_...&limit=25
 */

export interface PaginationParams {
  cursor: string | null;
  limit: number;
  decodedCursor: { id: string; created_at: string } | null;
}

export interface PaginatedResponse<T> {
  object: 'list';
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
  total_count?: number;
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

/**
 * Parse pagination parameters from query string.
 */
export function parsePagination(c: Context): PaginationParams {
  const rawCursor = c.req.query('cursor') || null;
  const rawLimit = c.req.query('limit');
  const limit = Math.min(Math.max(parseInt(rawLimit || String(DEFAULT_LIMIT)), 1), MAX_LIMIT);

  let decodedCursor: PaginationParams['decodedCursor'] = null;
  if (rawCursor) {
    try {
      const decoded = Buffer.from(rawCursor, 'base64url').toString('utf-8');
      decodedCursor = JSON.parse(decoded);
    } catch {
      // Invalid cursor — start from beginning
    }
  }

  return { cursor: rawCursor, limit, decodedCursor };
}

/**
 * Encode a cursor from a row's id and created_at.
 */
export function encodeCursor(row: { id: string; created_at: string }): string {
  return Buffer.from(JSON.stringify({ id: row.id, created_at: row.created_at })).toString('base64url');
}

/**
 * Build a paginated response envelope.
 */
export function paginatedResponse<T extends { id: string; created_at: string }>(
  rows: T[],
  limit: number,
  totalCount?: number
): PaginatedResponse<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const lastItem = data[data.length - 1];

  return {
    object: 'list',
    data,
    has_more: hasMore,
    next_cursor: hasMore && lastItem ? encodeCursor(lastItem) : null,
    ...(totalCount !== undefined ? { total_count: totalCount } : {}),
  };
}

/**
 * Build SQL WHERE clause for cursor pagination.
 * Returns { clause, params, nextParamIdx }.
 */
export function cursorWhereClause(
  decodedCursor: PaginationParams['decodedCursor'],
  startParamIdx: number
): { clause: string; params: any[]; nextParamIdx: number } {
  if (!decodedCursor) {
    return { clause: '', params: [], nextParamIdx: startParamIdx };
  }

  return {
    clause: ` AND (created_at, id) < ($${startParamIdx}, $${startParamIdx + 1})`,
    params: [decodedCursor.created_at, decodedCursor.id],
    nextParamIdx: startParamIdx + 2,
  };
}
