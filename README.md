# FormBuddy API

World-class REST API for FormBuddy — cross-platform intelligent form-filling.

Built with the same patterns that power Stripe's API: idempotency keys, cursor-based pagination, structured errors, expandable objects, webhook events, and API key authentication.

## Quick Start

```bash
# With Docker (recommended)
docker compose up

# Without Docker
cp .env.template .env     # fill in values
npm install
npm run migrate
npm run dev
```

## API Design Principles

| Pattern | Description |
|---------|-------------|
| **Idempotency Keys** | Send `Idempotency-Key` header on POST/PATCH/DELETE to safely retry requests |
| **Request IDs** | Every response includes `x-request-id` for debugging and support |
| **API Versioning** | Send `FormBuddy-Version: 2026-03-28` header to pin your integration |
| **Cursor Pagination** | All list endpoints use `?cursor=&limit=` instead of offset |
| **Expandable Objects** | Use `?expand[]=fields` to include related data inline |
| **ETags** | `If-None-Match` support for conditional requests and caching |
| **Structured Errors** | Every error returns `{error: {type, code, message, param}}` |
| **Webhook Events** | Real-time event delivery with HMAC-SHA256 signature verification |
| **Soft Deletes** | Profiles are recoverable for 30 days after deletion |
| **Audit Log** | Every mutation is logged for compliance |

## Authentication

Two authentication modes:

```bash
# JWT token (for client apps)
curl -H "Authorization: Bearer eyJ..." https://api.formbuddy.app/api/profiles

# API key (for server integrations)
curl -H "Authorization: Bearer fb_live_abc123..." https://api.formbuddy.app/api/profiles
```

API keys are scoped: `profiles:read`, `profiles:write`, `sync:read`, `sync:write`, `classify`, etc.

## Endpoints

### Auth
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/auth/register` | No | Create account |
| `POST` | `/api/auth/login` | No | Login, get tokens |
| `POST` | `/api/auth/refresh` | No | Refresh access token (O(1) lookup) |
| `POST` | `/api/auth/logout` | Yes | Revoke all sessions |
| `GET` | `/api/auth/me` | Yes | Get current user |

### Profiles
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/profiles` | Yes | List profiles (cursor pagination, expandable) |
| `GET` | `/api/profiles/:id` | Yes | Get profile with fields |
| `POST` | `/api/profiles` | Yes | Create profile |
| `PATCH` | `/api/profiles/:id` | Yes | Update profile/fields |
| `DELETE` | `/api/profiles/:id` | Yes | Soft delete (30-day recovery) |
| `POST` | `/api/profiles/:id/restore` | Yes | Recover deleted profile |
| `POST` | `/api/profiles/:id/clone` | Yes | Duplicate profile |

### Field Intelligence
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/fields/classify` | Yes | AI field classification (cached, rate-limited) |
| `POST` | `/api/fields/match` | Yes | Match profile fields to form with coverage stats |

### Sync
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/sync/push` | Yes | Push changes (vector clock conflict resolution) |
| `POST` | `/api/sync/pull` | Yes | Pull changes (paginated) |
| `GET` | `/api/sync/status` | Yes | Sync status per device |

### Form Templates
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/templates` | Yes | Browse templates (full-text search, cursor pagination) |
| `GET` | `/api/templates/:id` | Yes | Get template |
| `POST` | `/api/templates` | Yes | Create template |
| `DELETE` | `/api/templates/:id` | Yes | Delete own template |

### History
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/history` | Yes | Fill history (cursor pagination) |
| `POST` | `/api/history` | Yes | Log a form fill |
| `GET` | `/api/history/stats` | Yes | Statistics with 30-day breakdown |

### Billing
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/billing/status` | Yes | Subscription status |
| `POST` | `/api/billing/checkout` | Yes | Create Stripe checkout |
| `POST` | `/api/billing/portal` | Yes | Stripe customer portal |
| `POST` | `/api/billing/webhook` | No | Stripe webhook |

### API Keys
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/api-keys` | Yes | List API keys (prefix only) |
| `POST` | `/api/api-keys` | Yes | Create API key (Pro, shown once) |
| `DELETE` | `/api/api-keys/:id` | Yes | Revoke API key |

### Webhooks
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/webhooks` | Yes | List webhook endpoints |
| `POST` | `/api/webhooks` | Yes | Register endpoint (Pro) |
| `DELETE` | `/api/webhooks/:id` | Yes | Remove endpoint |

### Events
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/events` | Yes | List events (filterable by type) |
| `GET` | `/api/events/:id` | Yes | Get event details |

### Batch
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/batch/profiles/fields` | Yes | Batch update fields (atomic, up to 50 profiles) |

### Operations
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | No | Comprehensive health check |
| `GET` | `/health/live` | No | Liveness probe |

## Error Format

Every error follows the same structure:

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "validation_error",
    "message": "Human-readable description of what went wrong.",
    "param": "email"
  },
  "request_id": "req_a1b2c3d4..."
}
```

Error types: `invalid_request_error`, `authentication_error`, `authorization_error`, `api_error`, `rate_limit_error`

## Webhook Events

Events follow the `resource.action` convention:

- `profile.created`, `profile.updated`, `profile.deleted`, `profile.cloned`
- `sync.pushed`, `sync.pulled`, `sync.conflict`
- `subscription.created`, `subscription.updated`, `subscription.canceled`
- `fill.completed`
- `api_key.created`, `api_key.revoked`

Signature verification:

```javascript
const signature = crypto
  .createHmac('sha256', webhookSecret)
  .update(`${timestamp}.${body}`)
  .digest('hex');
```

## Architecture

- **Runtime**: Node.js + [Hono](https://hono.dev)
- **Database**: PostgreSQL with full-text search, partial indexes, GIN indexes
- **Auth**: JWT (client) + API keys (server-to-server), refresh token rotation with O(1) lookup
- **Encryption**: AES-256-GCM with versioned key rotation
- **Sync**: Vector clock per-field conflict resolution with paginated pull
- **AI**: Claude Haiku for field classification with form-hash caching
- **Billing**: Stripe subscriptions with webhook handling
- **Observability**: Request IDs, audit log, slow query warnings, health checks

## Environment Variables

See [`.env.template`](.env.template) for all required configuration.
