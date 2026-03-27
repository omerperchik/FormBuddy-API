/**
 * Stripe-style structured error responses.
 *
 * Every error returns:
 * {
 *   error: {
 *     type: "invalid_request_error" | "authentication_error" | "authorization_error" | "api_error" | "rate_limit_error",
 *     code: "resource_not_found",
 *     message: "Profile not found.",
 *     param: "profile_id",           // optional — which parameter caused the error
 *     doc_url: "https://..."         // optional — link to docs
 *   }
 * }
 */

export type ErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'authorization_error'
  | 'api_error'
  | 'rate_limit_error'
  | 'idempotency_error';

export interface ApiErrorBody {
  type: ErrorType;
  code: string;
  message: string;
  param?: string;
  doc_url?: string;
}

export class AppError extends Error {
  public body: ApiErrorBody;

  constructor(
    public statusCode: number,
    type: ErrorType,
    code: string,
    message: string,
    param?: string
  ) {
    super(message);
    this.name = 'AppError';
    this.body = { type, code, message };
    if (param) this.body.param = param;
  }

  toJSON() {
    return { error: this.body };
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, param?: string) {
    super(404, 'invalid_request_error', 'resource_not_found', `${resource} not found.`, param);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Invalid or missing authentication.') {
    super(401, 'authentication_error', 'unauthorized', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action.') {
    super(403, 'authorization_error', 'forbidden', message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, param?: string) {
    super(409, 'invalid_request_error', 'resource_conflict', message, param);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, param?: string) {
    super(400, 'invalid_request_error', 'validation_error', message, param);
  }
}

export class RateLimitError extends AppError {
  constructor() {
    super(429, 'rate_limit_error', 'rate_limit_exceeded',
      'Too many requests. Please retry after the period specified in the Retry-After header.');
  }
}

export class TierRequiredError extends AppError {
  constructor(requiredTier: string) {
    super(403, 'authorization_error', 'tier_required',
      `This endpoint requires the '${requiredTier}' plan. Upgrade at /api/billing/checkout.`);
  }
}
