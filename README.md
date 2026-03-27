# FormBuddy API

Centralized backend for FormBuddy — cross-platform intelligent form-filling.

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/auth/register` | No | Create account |
| `POST` | `/api/auth/login` | No | Login, get tokens |
| `POST` | `/api/auth/refresh` | No | Refresh access token |
| `POST` | `/api/auth/logout` | Yes | Revoke all sessions |
| `GET` | `/api/auth/me` | Yes | Get current user |
| `GET` | `/api/profiles` | Yes | List profiles |
| `GET` | `/api/profiles/:id` | Yes | Get profile with fields |
| `POST` | `/api/profiles` | Yes | Create profile |
| `PATCH` | `/api/profiles/:id` | Yes | Update profile/fields |
| `DELETE` | `/api/profiles/:id` | Yes | Delete profile |
| `POST` | `/api/profiles/:id/clone` | Yes | Duplicate profile |
| `POST` | `/api/fields/classify` | Yes | AI field classification |
| `POST` | `/api/fields/match` | Yes | Match profile to form |
| `POST` | `/api/sync/push` | Yes | Push local changes |
| `POST` | `/api/sync/pull` | Yes | Pull remote changes |
| `GET` | `/api/sync/status` | Yes | Sync status per device |
| `GET` | `/api/templates` | Yes | Browse form templates |
| `GET` | `/api/templates/:id` | Yes | Get template |
| `POST` | `/api/templates` | Yes | Create template |
| `DELETE` | `/api/templates/:id` | Yes | Delete own template |
| `GET` | `/api/history` | Yes | Fill history |
| `POST` | `/api/history` | Yes | Log a form fill |
| `GET` | `/api/history/stats` | Yes | Fill statistics |
| `GET` | `/api/billing/status` | Yes | Subscription status |
| `POST` | `/api/billing/checkout` | Yes | Create Stripe checkout |
| `POST` | `/api/billing/portal` | Yes | Stripe customer portal |
| `POST` | `/api/billing/webhook` | No | Stripe webhook |
| `GET` | `/health` | No | Health check |

## Quick Start

```bash
# With Docker
docker compose up

# Without Docker
cp .env.template .env  # fill in values
npm install
npm run migrate
npm run dev
```

## Architecture

- **Runtime**: Node.js + Hono
- **Database**: PostgreSQL
- **Auth**: JWT with refresh token rotation
- **Encryption**: AES-256-GCM for sensitive fields (national ID, passport, etc.)
- **Sync**: Vector clock per-field conflict resolution
- **AI**: Claude Haiku for form field classification (cached)
- **Billing**: Stripe subscriptions with webhook handling

## Environment Variables

See `.env.template` for all required configuration.
