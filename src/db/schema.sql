-- FormBuddy API Database Schema

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
  auth_provider TEXT DEFAULT 'email',        -- email | google | apple
  provider_id   TEXT,                         -- external provider user ID
  tier          TEXT DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'team')),
  stripe_customer_id TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_stripe ON users(stripe_customer_id);

-- ============================================================
-- REFRESH TOKENS
-- ============================================================
CREATE TABLE refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  device     TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);

-- ============================================================
-- PROFILES
-- ============================================================
CREATE TABLE profiles (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL DEFAULT 'Personal',
  type       TEXT DEFAULT 'personal' CHECK (type IN ('personal', 'work', 'family', 'custom')),
  icon       TEXT DEFAULT '👤',
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_profiles_user ON profiles(user_id);

-- One default profile per user
CREATE UNIQUE INDEX idx_profiles_default ON profiles(user_id) WHERE is_default = true;

-- ============================================================
-- PROFILE FIELDS (normalized for per-field sync & encryption)
-- ============================================================
CREATE TABLE profile_fields (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  profile_id   UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  field_key    TEXT NOT NULL,                -- e.g. 'givenName', 'email', 'nationalId'
  value        TEXT NOT NULL,                -- encrypted for sensitive fields
  is_sensitive BOOLEAN DEFAULT false,        -- true = E2E encrypted
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  vector_clock INTEGER DEFAULT 1,            -- for conflict resolution
  UNIQUE(profile_id, field_key)
);

CREATE INDEX idx_profile_fields_profile ON profile_fields(profile_id);

-- ============================================================
-- CUSTOM FIELDS (user-defined fields per profile)
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
-- FORM TEMPLATES (reusable form definitions)
-- ============================================================
CREATE TABLE form_templates (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name           TEXT NOT NULL,
  description    TEXT,
  category       TEXT,                      -- e.g. 'government', 'medical', 'employment'
  country        TEXT,                      -- ISO country code
  language       TEXT DEFAULT 'en',
  field_mappings JSONB NOT NULL DEFAULT '[]', -- [{fieldKey, label, autocomplete, required}]
  is_public      BOOLEAN DEFAULT false,
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  use_count      INTEGER DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_form_templates_category ON form_templates(category);
CREATE INDEX idx_form_templates_public ON form_templates(is_public) WHERE is_public = true;

-- ============================================================
-- FILL HISTORY (track which forms were filled)
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
  filled_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_fill_history_user ON fill_history(user_id);
CREATE INDEX idx_fill_history_date ON fill_history(filled_at DESC);

-- ============================================================
-- FIELD CLASSIFICATION CACHE (avoid re-classifying same forms)
-- ============================================================
CREATE TABLE field_classification_cache (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  form_hash       TEXT NOT NULL,             -- hash of form structure
  field_name      TEXT NOT NULL,
  field_label     TEXT,
  field_type_html TEXT,
  classified_type TEXT NOT NULL,             -- mapped FieldType
  confidence      REAL DEFAULT 1.0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(form_hash, field_name)
);

CREATE INDEX idx_field_cache_hash ON field_classification_cache(form_hash);

-- ============================================================
-- SYNC LEDGER (track per-device sync state)
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
-- UPDATED_AT TRIGGER
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
