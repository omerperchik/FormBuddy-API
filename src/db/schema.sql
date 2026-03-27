-- FormBuddy API Database Schema — World-Class Edition
-- Designed with Stripe-level operational patterns

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT,
  avatar_url    TEXT,
  auth_provider TEXT DEFAULT 'email',
  provider_id   TEXT,
  tier          TEXT DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'team')),
  stripe_customer_id TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ             -- soft delete
);

CREATE INDEX idx_users_email ON users(email) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_stripe ON users(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- ============================================================
-- REFRESH TOKENS (O(1) lookup via token prefix)
-- ============================================================
CREATE TABLE refresh_tokens (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_prefix TEXT NOT NULL,             -- first 8 chars for O(1) lookup
  token_hash   TEXT NOT NULL,
  device       TEXT,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_refresh_tokens_prefix ON refresh_tokens(token_prefix);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_expires ON refresh_tokens(expires_at);

-- ============================================================
-- API KEYS (server-to-server auth, like Stripe)
-- ============================================================
CREATE TABLE api_keys (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL DEFAULT 'Default',
  key_hash     TEXT UNIQUE NOT NULL,      -- SHA256 of the full key
  key_prefix   TEXT NOT NULL,             -- first 12 chars for display (fb_live_xxx...)
  scopes       TEXT[] NOT NULL DEFAULT ARRAY['*'],
  is_test_mode BOOLEAN DEFAULT false,
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_api_keys_hash ON api_keys(key_hash) WHERE revoked_at IS NULL;
CREATE INDEX idx_api_keys_user ON api_keys(user_id);

-- ============================================================
-- PROFILES (with soft delete)
-- ============================================================
CREATE TABLE profiles (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL DEFAULT 'Personal',
  type       TEXT DEFAULT 'personal' CHECK (type IN ('personal', 'work', 'family', 'custom')),
  icon       TEXT DEFAULT '👤',
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ             -- soft delete with 30-day recovery
);

CREATE INDEX idx_profiles_user ON profiles(user_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_profiles_default ON profiles(user_id) WHERE is_default = true AND deleted_at IS NULL;

-- ============================================================
-- PROFILE FIELDS
-- ============================================================
CREATE TABLE profile_fields (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  profile_id   UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  field_key    TEXT NOT NULL,
  value        TEXT NOT NULL,
  is_sensitive BOOLEAN DEFAULT false,
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  vector_clock INTEGER DEFAULT 1,
  UNIQUE(profile_id, field_key)
);

CREATE INDEX idx_profile_fields_profile ON profile_fields(profile_id);
CREATE INDEX idx_profile_fields_updated ON profile_fields(updated_at);

-- ============================================================
-- CUSTOM FIELDS
-- ============================================================
CREATE TABLE custom_fields (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  value      TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_custom_fields_profile ON custom_fields(profile_id);

-- ============================================================
-- FORM TEMPLATES
-- ============================================================
CREATE TABLE form_templates (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name           TEXT NOT NULL,
  description    TEXT,
  category       TEXT,
  country        TEXT,
  language       TEXT DEFAULT 'en',
  field_mappings JSONB NOT NULL DEFAULT '[]',
  is_public      BOOLEAN DEFAULT false,
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  use_count      INTEGER DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_form_templates_category ON form_templates(category);
CREATE INDEX idx_form_templates_public ON form_templates(is_public, use_count DESC) WHERE is_public = true;
CREATE INDEX idx_form_templates_search ON form_templates USING gin(to_tsvector('english', coalesce(name, '') || ' ' || coalesce(description, '')));

-- ============================================================
-- FILL HISTORY
-- ============================================================
CREATE TABLE fill_history (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id      UUID REFERENCES profiles(id) ON DELETE SET NULL,
  template_id     UUID REFERENCES form_templates(id) ON DELETE SET NULL,
  form_url        TEXT,
  form_title      TEXT,
  fields_filled   INTEGER DEFAULT 0,
  source_platform TEXT CHECK (source_platform IN ('chrome', 'android', 'ios', 'web')),
  filled_at       TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_fill_history_user ON fill_history(user_id, filled_at DESC);

-- ============================================================
-- FIELD CLASSIFICATION CACHE
-- ============================================================
CREATE TABLE field_classification_cache (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  form_hash       TEXT NOT NULL,
  field_name      TEXT NOT NULL,
  field_label     TEXT,
  field_type_html TEXT,
  classified_type TEXT NOT NULL,
  confidence      REAL DEFAULT 1.0,
  hit_count       INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(form_hash, field_name)
);

CREATE INDEX idx_field_cache_hash ON field_classification_cache(form_hash);

-- ============================================================
-- SYNC LEDGER
-- ============================================================
CREATE TABLE sync_ledger (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   TEXT NOT NULL,
  platform    TEXT NOT NULL,
  last_synced TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, device_id)
);

CREATE INDEX idx_sync_ledger_user ON sync_ledger(user_id);

-- ============================================================
-- SUBSCRIPTIONS
-- ============================================================
CREATE TABLE subscriptions (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status                 TEXT DEFAULT 'active' CHECK (status IN ('active', 'canceled', 'past_due', 'trialing')),
  plan                   TEXT DEFAULT 'pro_monthly',
  stripe_subscription_id TEXT UNIQUE,
  current_period_start   TIMESTAMPTZ,
  current_period_end     TIMESTAMPTZ,
  created_at             TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_stripe ON subscriptions(stripe_subscription_id);

-- ============================================================
-- IDEMPOTENCY KEYS (Stripe-style request deduplication)
-- ============================================================
CREATE TABLE idempotency_keys (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key_hash        TEXT UNIQUE NOT NULL,
  request_path    TEXT NOT NULL,
  request_method  TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body   TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_idempotency_expires ON idempotency_keys(expires_at);

-- ============================================================
-- EVENTS (webhook event log — immutable audit trail)
-- ============================================================
CREATE TABLE events (
  id                  TEXT PRIMARY KEY,     -- evt_xxx format
  type                TEXT NOT NULL,
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data                JSONB NOT NULL,
  previous_attributes JSONB,
  request_id          TEXT,
  idempotency_key     TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_events_user ON events(user_id, created_at DESC);
CREATE INDEX idx_events_type ON events(type, created_at DESC);

-- ============================================================
-- WEBHOOK ENDPOINTS (user-registered webhook URLs)
-- ============================================================
CREATE TABLE webhook_endpoints (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  secret      TEXT NOT NULL,
  description TEXT,
  event_types TEXT[] DEFAULT ARRAY['*'],
  status      TEXT DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_webhook_endpoints_user ON webhook_endpoints(user_id) WHERE status = 'active';

-- ============================================================
-- WEBHOOK DELIVERIES (delivery attempts log)
-- ============================================================
CREATE TABLE webhook_deliveries (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  endpoint_id UUID NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  status_code INTEGER,
  success     BOOLEAN DEFAULT false,
  error       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_webhook_deliveries_event ON webhook_deliveries(event_id);

-- ============================================================
-- AUDIT LOG (every mutation, for compliance)
-- ============================================================
CREATE TABLE audit_log (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL,
  action        TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id   TEXT,
  ip_address    INET,
  user_agent    TEXT,
  request_id    TEXT,
  api_key_id    TEXT,
  metadata      JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_log_user ON audit_log(user_id, created_at DESC);
CREATE INDEX idx_audit_log_resource ON audit_log(resource_type, resource_id);

-- ============================================================
-- UPDATED_AT TRIGGERS
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_profiles_updated_at BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_profile_fields_updated_at BEFORE UPDATE ON profile_fields FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_form_templates_updated_at BEFORE UPDATE ON form_templates FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- CLEANUP: Expired idempotency keys and refresh tokens
-- Run via pg_cron or application-level scheduler
-- ============================================================
-- DELETE FROM idempotency_keys WHERE expires_at < NOW();
-- DELETE FROM refresh_tokens WHERE expires_at < NOW();
